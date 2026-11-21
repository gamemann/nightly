import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { OPEN_STATUSES } from '~/lib/constants'
import { type Budget, compareFunctions, compareMetrics, evaluateBudgets, regressionMarkers } from '../../lib/perf.mjs'
import { procedure, router } from './trpc'

// Reads go through Prisma. Every write is `bin/nightly perf ...`: one writer, one place for the rules (budget breaches, dedupe, size limits).
const execp = promisify(execFile)
async function cli(args: string[], input?: string) {
    try {
        const p = execp(path.join(process.cwd(), 'bin', 'nightly'), args, { timeout: 60_000, env: { ...process.env }, maxBuffer: 64 << 20 })
        if (input !== undefined) p.child.stdin?.end(input)
        return (await p).stdout.trim()
    } catch (e) {
        const err = e as { stderr?: string; message: string }
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err.stderr || err.message).replace(/^nightly: /, '').trim() })
    }
}
export const perfIngest = (args: string[], text: string) => cli(['perf', 'ingest', '-', '--json', ...args], text)

const json = <T,>(s: string, d: T): T => { try { return JSON.parse(s) as T } catch { return d } }
const PERF_DIR = () => process.env.NIGHTLY_PERF_DIR || path.join(path.dirname(process.env.NIGHTLY_DB || path.join(process.cwd(), 'data', 'nightly.db')), 'perf')
const OPEN = new Set<string>(OPEN_STATUSES)
const scope = z.object({ game: z.string(), platform: z.string().optional(), role: z.string().optional(), map: z.string().optional(), bots: z.number().optional() })

function runWhere(i: z.infer<typeof scope>) {
    return { game: i.game, ...(i.platform ? { platform: i.platform } : {}), ...(i.role ? { role: i.role } : {}), ...(i.map !== undefined ? { map: i.map } : {}), ...(i.bots !== undefined ? { bots: i.bots } : {}) }
}

export const perfRouter = router({
    /** Every registered game with its newest run and open findings. */
    games: procedure.query(async ({ ctx }) => {
        const [games, findings] = await Promise.all([ctx.db.perfGame.findMany({ orderBy: { slug: 'asc' } }), ctx.db.perfFinding.findMany({ where: { status: 'open' } })])
        return Promise.all(games.map(async (g) => {
            const last = await ctx.db.perfRun.findFirst({ where: { game: g.slug }, orderBy: [{ ranAt: 'desc' }, { id: 'desc' }], select: { id: true, ranAt: true, commit: true } })
            const runs = await ctx.db.perfRun.count({ where: { game: g.slug } })
            return { ...g, platforms: g.platforms.split(',').filter(Boolean), budgets: json<Budget[]>(g.budgets, []), routing: json<Record<string, unknown>>(g.routing, {}), addons: json<Record<string, string>>(g.addons, {}), last, runs, open: findings.filter((f) => f.game === g.slug).length }
        }))
    }),

    /** Distinct map/bots/platform/role combinations seen for a game (filter menus) and the metric names. */
    facets: procedure.input(z.object({ game: z.string() })).query(async ({ ctx, input }) => {
        const [combos, names] = await Promise.all([
            ctx.db.perfRun.groupBy({ by: ['platform', 'role', 'map', 'bots'], where: { game: input.game }, _count: { _all: true }, orderBy: { _count: { id: 'desc' } }, take: 200 }),
            ctx.db.perfMetric.groupBy({ by: ['name'], where: { run: { game: input.game } } }),
        ])
        return { combos: combos.map((c) => ({ platform: c.platform, role: c.role, map: c.map, bots: c.bots, n: c._count._all })), metrics: names.map((n) => n.name).sort() }
    }),

    /** Paginated run list (newest first) with the headline metrics. */
    runs: procedure.input(scope.extend({ page: z.number().int().min(0).default(0), pageSize: z.number().int().min(1).max(200).default(25), q: z.string().optional() })).query(async ({ ctx, input }) => {
        const where = { ...runWhere(input), ...(input.q ? { OR: [{ commit: { contains: input.q } }, { label: { contains: input.q } }, { name: { contains: input.q } }, { map: { contains: input.q } }] } : {}) }
        const [total, rows] = await Promise.all([
            ctx.db.perfRun.count({ where }),
            ctx.db.perfRun.findMany({ where, orderBy: [{ ranAt: 'desc' }, { id: 'desc' }], skip: input.page * input.pageSize, take: input.pageSize, include: { metrics: { where: { name: { in: ['fps', 'frame_ms_p95', 'tick_ms', 'memory_mb', 'draw_calls'] } } } } }),
        ])
        return { total, rows: rows.map((r) => ({ ...r, metrics: Object.fromEntries(r.metrics.map((m) => [m.name, m.value])) })) }
    }),

    /** One run: metrics, budgets with verdicts, profiler table, folded stacks text (if kept), findings. */
    run: procedure.input(z.object({ id: z.number().int() })).query(async ({ ctx, input }) => {
        const r = await ctx.db.perfRun.findUnique({ where: { id: input.id }, include: { metrics: true, funcs: { orderBy: { selfMs: 'desc' } } } })
        if (!r) throw new TRPCError({ code: 'NOT_FOUND', message: `no run #${input.id}` })
        const game = await ctx.db.perfGame.findUnique({ where: { slug: r.game } })
        const metrics = Object.fromEntries(r.metrics.map((m) => [m.name, m.value]))
        const budgets = json<Budget[]>(game?.budgets ?? '[]', [])
        const ev = evaluateBudgets(budgets, r, metrics)
        let folded: string | null = null
        let reportJson = false
        if (r.artefact) {
            folded = await readFile(path.join(PERF_DIR(), r.artefact, 'stacks.folded'), 'utf8').catch(() => null)
            reportJson = !!(await readFile(path.join(PERF_DIR(), r.artefact, 'report.json'), 'utf8').then(() => true, () => false))
        }
        const { metrics: _m, funcs, ...run } = r
        return { run, metrics, funcs, budgets: ev.checked.map((b) => ({ ...b, breached: ev.breaches.some((x) => x.metric === b.metric && x.limit === (b.max ?? b.min)) })), folded, reportJson }
    }),

    /** Trend of one metric over time for one scope, with the applicable budget lines and regression markers. */
    trend: procedure.input(scope.extend({ metric: z.string(), limit: z.number().int().min(2).max(2000).default(120) })).query(async ({ ctx, input }) => {
        const rows = await ctx.db.perfRun.findMany({ where: { ...runWhere(input), metrics: { some: { name: input.metric } } }, orderBy: [{ ranAt: 'desc' }, { id: 'desc' }], take: input.limit, select: { id: true, ranAt: true, commit: true, label: true, platform: true, role: true, map: true, bots: true, metrics: { where: { name: input.metric }, select: { value: true } } } })
        const points = rows.reverse().map((r) => ({ id: r.id, ranAt: r.ranAt, commit: r.commit, label: r.label, value: r.metrics[0].value }))
        const game = await ctx.db.perfGame.findUnique({ where: { slug: input.game } })
        const budgets = json<Budget[]>(game?.budgets ?? '[]', []).filter((b) => b.metric === input.metric && (!b.platform || !input.platform || b.platform === input.platform) && (!b.role || !input.role || b.role === input.role) && (!b.map || b.map === input.map) && (b.bots === undefined || b.bots === input.bots))
        return { points, budgets, markers: regressionMarkers(points, input.metric) }
    }),

    /** A vs B: metric deltas and per-function deltas. */
    compare: procedure.input(z.object({ a: z.number().int(), b: z.number().int(), noisePct: z.number().default(5) })).query(async ({ ctx, input }) => {
        const [a, b] = await Promise.all([input.a, input.b].map((id) => ctx.db.perfRun.findUnique({ where: { id }, include: { metrics: true, funcs: true } })))
        if (!a || !b) throw new TRPCError({ code: 'NOT_FOUND', message: 'run not found' })
        const m = (r: typeof a) => Object.fromEntries(r.metrics.map((x) => [x.name, x.value]))
        const { metrics: _a, funcs: fa, ...ra } = a
        const { metrics: _b, funcs: fb, ...rb } = b
        return { a: ra, b: rb, metrics: compareMetrics(m(a), m(b), { noisePct: input.noisePct }), funcs: compareFunctions(fa, fb, { noisePct: input.noisePct }).slice(0, 200) }
    }),

    /** Top offenders: functions by self time over the newest runs of a scope, plus the open findings, per game. */
    offenders: procedure.input(scope.extend({ runs: z.number().int().min(1).max(50).default(5) })).query(async ({ ctx, input }) => {
        const latest = await ctx.db.perfRun.findMany({ where: runWhere(input), orderBy: [{ ranAt: 'desc' }, { id: 'desc' }], take: input.runs, select: { id: true } })
        const ids = latest.map((r) => r.id)
        const rows = ids.length ? await ctx.db.perfFunc.groupBy({ by: ['name', 'grp', 'addon'], where: { runId: { in: ids } }, _avg: { selfMs: true, totalMs: true }, _sum: { calls: true }, _count: { _all: true }, orderBy: { _avg: { selfMs: 'desc' } }, take: 50 }) : []
        const total = rows.reduce((s, r) => s + (r._avg.selfMs ?? 0), 0)
        return { runs: ids.length, rows: rows.map((r) => ({ name: r.name, grp: r.grp, addon: r.addon, selfMs: r._avg.selfMs ?? 0, totalMs: r._avg.totalMs ?? 0, seen: r._count._all, share: total ? (r._avg.selfMs ?? 0) / total : 0 })) }
    }),

    /** Findings with the status of the queue item each is linked to. */
    findings: procedure.input(z.object({ game: z.string().optional() })).query(async ({ ctx, input }) => {
        const f = await ctx.db.perfFinding.findMany({ where: input.game ? { game: input.game } : {}, orderBy: { updatedAt: 'desc' }, take: 200 })
        const items = await ctx.db.item.findMany({ where: { key: { in: f.map((x) => x.itemKey).filter(Boolean) } }, select: { key: true, status: true, title: true } })
        return f.map((x) => ({ ...x, item: items.find((i) => i.key === x.itemKey) ?? null, itemOpen: OPEN.has(items.find((i) => i.key === x.itemKey)?.status ?? '') }))
    }),

    // ---- writes (via the CLI) ----
    addGame: procedure.input(z.object({ id: z.string(), name: z.string(), repo: z.string().default(''), repoPath: z.string().default(''), engine: z.string().default('godot'), platforms: z.string().default('native,web'), owner: z.string().default(''), budgets: z.array(z.string()).default([]), routing: z.string().default('{}') })).mutation(async ({ input }) => {
        const args = ['perf', 'game', 'add', '--id', input.id, '--name', input.name, '--engine', input.engine, '--platforms', input.platforms, '--routing', input.routing]
        for (const [k, v] of [['--repo', input.repo], ['--repo-path', input.repoPath], ['--owner', input.owner]] as const) if (v) args.push(k, v)
        for (const b of input.budgets) args.push('--budget', b)
        return cli(args)
    }),
    setBudgets: procedure.input(z.object({ id: z.string(), budgets: z.array(z.string()) })).mutation(async ({ input }) => {
        // `--budgets` takes a JSON list; strings are parsed by the CLI, the empty list clears them.
        return cli(['perf', 'game', 'set', '--id', input.id, '--budgets', JSON.stringify(input.budgets)])
    }),
    linkFinding: procedure.input(z.object({ game: z.string(), metric: z.string(), item: z.string().optional(), title: z.string().optional() })).mutation(async ({ input }) => {
        const args = ['perf', 'finding', 'add', '--game', input.game, '--metric', input.metric]
        if (input.item) args.push('--item', input.item)
        if (input.title) args.push('--title', input.title)
        return cli(args)
    }),
})
