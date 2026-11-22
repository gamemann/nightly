import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { OPEN_STATUSES } from '~/lib/constants'
import { type Budget, compareFunctions, compareMetrics, evaluateBudgets, regressionMarkers } from '../../lib/perf.mjs'
import { bestFolded, diffFlameSvg, diffRows, flameSvg, hitchSvg, hitchesFromReport, sparklineSvg } from '../../lib/perf-viz.mjs'
import { procedure, router } from './trpc'

// Reads go through Prisma. Every write is `bin/nightly perf ...`: one writer, one place for the rules (budget breaches, dedupe, size limits).
const execp = promisify(execFile)
async function cli(args: string[], input?: string, env?: Record<string, string>) {
    try {
        const p = execp(path.join(process.cwd(), 'bin', 'nightly'), args, { timeout: 60_000, env: { ...process.env, ...env }, maxBuffer: 64 << 20 })
        if (input !== undefined) p.child.stdin?.end(input)
        return (await p).stdout.trim()
    } catch (e) {
        const err = e as { stderr?: string; message: string }
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err.stderr || err.message).replace(/^nightly: /, '').trim() })
    }
}
/** `token` travels in the environment (never argv: ps and logs would show it). */
export const perfIngest = (args: string[], text: string, token = '') => cli(['perf', 'ingest', '-', '--json', ...args], text, token ? { NIGHTLY_PERF_TOKEN: token } : undefined)

const nightlyBin = () => path.join(process.cwd(), 'bin', 'nightly')
const tokenEnv = (token: string) => ({ ...process.env, ...(token ? { NIGHTLY_PERF_TOKEN: token } : {}) })
/** The CI gate. Exit 1 (fail) still carries the JSON verdict on stdout. 0 pass -> 200, 1 fail -> 422, 2 no run -> 404. */
export async function perfGate(args: string[], token = ''): Promise<{ status: number; body: unknown }> {
    try {
        const p = await execp(nightlyBin(), ['perf', 'gate', '--json', ...args], { timeout: 60_000, env: tokenEnv(token), maxBuffer: 8 << 20 })
        return { status: 200, body: JSON.parse(p.stdout) }
    } catch (e) {
        const err = e as { code?: number; stdout?: string; stderr?: string; message: string }
        if (err.code === 1 && err.stdout) return { status: 422, body: JSON.parse(err.stdout) }
        return { status: err.code === 2 ? 404 : 400, body: { error: (err.stderr || err.message).replace(/^nightly: /, '').trim() } }
    }
}
/** Attach a png to a run: the bytes travel on stdin. */
export async function perfShot(args: string[], png: Buffer, token = ''): Promise<string> {
    const p = execp(nightlyBin(), ['perf', 'shot', 'add', '-', '--json', ...args], { timeout: 60_000, env: tokenEnv(token), maxBuffer: 8 << 20 })
    p.child.stdin?.end(png)
    try { return (await p).stdout.trim() } catch (e) { const err = e as { stderr?: string; message: string }; throw new Error((err.stderr || err.message).replace(/^nightly: /, '').trim()) }
}
/** The per-run report file (md, svg or png) produced by `perf report`. */
export async function perfReport(id: number, format: 'md' | 'svg' | 'png'): Promise<Buffer> {
    const dir = await mkdtemp(path.join(tmpdir(), 'perf-report-'))
    try {
        await cli(['perf', 'report', String(id), '--out', dir, '--json', ...(format === 'png' ? ['--png'] : [])])
        const f = (await readdir(dir)).find((n) => n.endsWith('.' + format))
        if (!f) throw new Error('report not produced')
        return await readFile(path.join(dir, f))
    } finally { await rm(dir, { recursive: true, force: true }) }
}

type FoldRun = { artefact: string; funcs: { name: string; path: string; per: string; selfMs: number }[] }
async function storedFolded(r: FoldRun) {
    const rd = (f: string) => (r.artefact ? readFile(path.join(PERF_DIR(), r.artefact, f), 'utf8').catch(() => '') : Promise.resolve(''))
    const [stacks, report] = await Promise.all([rd('stacks.folded'), rd('report.json')])
    return { folded: bestFolded({ stacks, report, funcs: r.funcs }) as string, report }
}
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

    /** Every metric of the newest runs of a scope in one query (oldest first), plus the budgets that apply to the scope:
     *  what the Trends dashboard shapes into charts, cards, heatmap and diffs (lib/perf-chart.mjs). */
    trendAll: procedure.input(scope.extend({ limit: z.number().int().min(2).max(1000).default(120) })).query(async ({ ctx, input }) => {
        const rows = await ctx.db.perfRun.findMany({ where: runWhere(input), orderBy: [{ ranAt: 'desc' }, { id: 'desc' }], take: input.limit, select: { id: true, ranAt: true, commit: true, build: true, label: true, platform: true, role: true, map: true, bots: true, metrics: { select: { name: true, value: true } } } })
        const runs = rows.reverse().map((r) => ({ id: r.id, ranAt: r.ranAt.toISOString(), commit: r.commit, build: r.build, label: r.label, platform: r.platform, role: r.role, map: r.map, bots: r.bots, metrics: Object.fromEntries(r.metrics.map((m) => [m.name, m.value])) as Record<string, number> }))
        const game = await ctx.db.perfGame.findUnique({ where: { slug: input.game } })
        const budgets = json<Budget[]>(game?.budgets ?? '[]', []).filter((b) => (!b.platform || !input.platform || b.platform === input.platform) && (!b.role || !input.role || b.role === input.role) && (!b.map || b.map === input.map) && (b.bots === undefined || b.bots === input.bots))
        return { runs, budgets }
    }),

    /** Visuals of one run: flame graph, hitch timeline, screenshots. The SVG strings come from lib/perf-viz (all text escaped). */
    viz: procedure.input(z.object({ id: z.number().int() })).query(async ({ ctx, input }) => {
        const r = await ctx.db.perfRun.findUnique({ where: { id: input.id }, include: { funcs: true } })
        if (!r) throw new TRPCError({ code: 'NOT_FOUND', message: `no run #${input.id}` })
        const { folded, report } = await storedFolded(r)
        const hitches = hitchesFromReport(json(report || '{}', {}))
        const game = await ctx.db.perfGame.findUnique({ where: { slug: r.game } })
        const frameBudget = json<Budget[]>(game?.budgets ?? '[]', []).find((b) => b.metric === 'frame_ms_p95' && b.max !== undefined)?.max
        const shots = await ctx.db.perfShot.findMany({ where: { runId: r.id }, orderBy: { id: 'asc' } })
        return { flame: folded ? flameSvg(folded, { title: `run #${r.id} flame graph (width = self time per frame)` }) : '', hitch: hitches.length ? hitchSvg(hitches, { budgetMs: frameBudget }) : '', hitches: hitches.length, shots }
    }),

    /** Differential flame graph between any two runs (red = slower in B, green = faster) and the biggest self-time changes. */
    diff: procedure.input(z.object({ a: z.number().int(), b: z.number().int(), noisePct: z.number().default(5) })).query(async ({ ctx, input }) => {
        const [a, b] = await Promise.all([input.a, input.b].map((id) => ctx.db.perfRun.findUnique({ where: { id }, include: { funcs: true } })))
        if (!a || !b) throw new TRPCError({ code: 'NOT_FOUND', message: 'run not found' })
        const [fa, fb] = await Promise.all([storedFolded(a), storedFolded(b)])
        const rows = diffRows(fa.folded, fb.folded, { top: 15 }).map((x: { path: string; a: number; b: number; delta: number }) => ({ path: x.path, a: x.a / 1000, b: x.b / 1000, delta: x.delta / 1000 }))
        const hasStacks = !!(fa.folded && fb.folded)
        return { svg: hasStacks ? diffFlameSvg(fa.folded, fb.folded, { noisePct: input.noisePct, title: `${a.game}: run #${a.id} -> run #${b.id} (red = slower, green = faster)` }) : '', rows, hasStacks, game: a.game }
    }),

    /** One function's self ms per frame over the newest runs of a scope: the per-function history sparkline. */
    funcHistory: procedure.input(scope.extend({ name: z.string(), limit: z.number().int().min(2).max(500).default(60) })).query(async ({ ctx, input }) => {
        const rows = await ctx.db.perfRun.findMany({ where: { ...runWhere(input), funcs: { some: { name: input.name } } }, orderBy: [{ ranAt: 'desc' }, { id: 'desc' }], take: input.limit, select: { id: true, ranAt: true, commit: true, funcs: { where: { name: input.name, per: 'frame' }, select: { selfMs: true } } } })
        const points = rows.reverse().map((r) => ({ id: r.id, ranAt: r.ranAt, commit: r.commit, value: r.funcs.reduce((x, f) => x + f.selfMs, 0) }))
        return { points, svg: sparklineSvg(points.map((p) => p.value), { width: 160, height: 30 }) }
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
        // The queue item each function was auto-filed under (one per game + function, see fileOffenders).
        const fins = await ctx.db.perfFinding.findMany({ where: { game: input.game, kind: 'offender' }, select: { fn: true, itemKey: true, state: true } })
        const itemOf = (n: string) => fins.find((f) => f.fn === n && f.itemKey) ?? null
        return { runs: ids.length, rows: rows.map((r) => ({ name: r.name, grp: r.grp, addon: r.addon, selfMs: r._avg.selfMs ?? 0, totalMs: r._avg.totalMs ?? 0, seen: r._count._all, share: total ? (r._avg.selfMs ?? 0) / total : 0, itemKey: itemOf(r.name)?.itemKey ?? '', rsi: itemOf(r.name)?.state ?? '' })) }
    }),

    /** Findings with the status of the queue item each is linked to. */
    findings: procedure.input(z.object({ game: z.string().optional() })).query(async ({ ctx, input }) => {
        const f = await ctx.db.perfFinding.findMany({ where: input.game ? { game: input.game } : {}, orderBy: { updatedAt: 'desc' }, take: 200 })
        const items = await ctx.db.item.findMany({ where: { key: { in: f.map((x) => x.itemKey).filter(Boolean) } }, select: { key: true, status: true, title: true } })
        return f.map((x) => ({ ...x, item: items.find((i) => i.key === x.itemKey) ?? null, itemOpen: OPEN.has(items.find((i) => i.key === x.itemKey)?.status ?? '') }))
    }),

    /** The RSI loop per game: every finding with its state (found, fixed, remeasured, dismissed) and the before/after delta. */
    rsi: procedure.input(z.object({ game: z.string().optional() })).query(async ({ ctx, input }) => {
        const f = await ctx.db.perfFinding.findMany({ where: input.game ? { game: input.game } : {}, orderBy: [{ game: 'asc' }, { updatedAt: 'desc' }], take: 500 })
        const items = await ctx.db.item.findMany({ where: { key: { in: f.map((x) => x.itemKey).filter(Boolean) } }, select: { key: true, status: true, title: true } })
        return f.map((x) => {
            const it = items.find((i) => i.key === x.itemKey)
            const delta = x.beforeValue != null && x.afterValue != null ? x.afterValue - x.beforeValue : null
            return { id: x.id, game: x.game, kind: x.kind, metric: x.metric, fn: x.fn, state: x.state, value: x.value, limit: x.limit, note: x.note, itemKey: x.itemKey, itemStatus: it?.status ?? '', itemTitle: it?.title ?? '',
                before: x.beforeValue, after: x.afterValue, delta, pct: delta != null && x.beforeValue ? (delta / Math.abs(x.beforeValue)) * 100 : null, runId: x.runId, remeasuredRunId: x.remeasuredRunId,
                updatedAt: x.updatedAt, cycles: json<unknown[]>(x.history, []).length }
        })
    }),

    /** Ingest tokens (hash and secret never leave the database). */
    tokens: procedure.query(({ ctx }) => ctx.db.perfToken.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, prefix: true, game: true, createdAt: true, lastUsedAt: true, revokedAt: true } })),

    // ---- writes (via the CLI) ----
    /** Returns {token} once: it is the only time the secret exists in clear. */
    tokenAdd: procedure.input(z.object({ name: z.string().min(1).max(40), game: z.string().default('') })).mutation(async ({ input }) => {
        const args = ['perf', 'token', 'add', '--name', input.name, '--json']
        if (input.game) args.push('--game', input.game)
        return json<{ name: string; game: string; prefix: string; token: string }>(await cli(args), { name: input.name, game: input.game, prefix: '', token: '' })
    }),
    tokenRevoke: procedure.input(z.object({ name: z.string() })).mutation(({ input }) => cli(['perf', 'token', 'revoke', input.name])),
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
