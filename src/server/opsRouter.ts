import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import type { PrismaClient } from '../../generated/prisma/client'
import { can, canProject } from '../../lib/permissions.mjs'
import { projectScope } from './projectsRouter'
import { procedure as baseProcedure, router } from './trpc'

// Ops pages: CI workflows, script checks, GitHub API budget, offloaded jobs (playtests), perf<->playtest links.
// Reads: Prisma (raw SQL for the tables lib/ops-store.mjs creates). Writes: `bin/nightly gh|ci|check|offload ...` (one writer).
const execp = promisify(execFile)
async function cli(...args: string[]) {
    try {
        const { stdout } = await execp(path.join(process.cwd(), 'bin', 'nightly'), args, { timeout: 60_000, env: { ...process.env }, maxBuffer: 4 << 20 })
        return stdout.trim()
    } catch (e) {
        const err = e as { stderr?: string; message: string }
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err.stderr || err.message).replace(/^nightly: /, '').trim() })
    }
}

/** Permission seam: `ctx.perms.can(key, projectSlug?)`. Global grants first; with a project slug, the viewer's
 *  project and folder grants (ProjectAccess) count too. No perms on the context means FORBIDDEN, never allow-all. */
export type Perms = { can(key: string, projectSlug?: string): boolean }
export function requirePerm(ctx: unknown, key: string, projectSlug?: string) {
    const perms = (ctx as { perms?: Perms }).perms
    if (!perms || !perms.can(key, projectSlug)) throw new TRPCError({ code: 'FORBIDDEN', message: `missing permission ${key}${projectSlug ? ` on ${projectSlug}` : ''}` })
}
/** Every ops procedure: signed in (baseProcedure), plus `perms` built from the viewer's roles and project scope. */
const procedure = baseProcedure.use(async ({ ctx, next }) => {
    const v = ctx.viewer
    const [scope, projects] = await Promise.all([projectScope(v), ctx.db.project.findMany({ select: { id: true, slug: true } })])
    const ids = new Map(projects.map((p) => [p.slug, p.id]))
    const perms: Perms = {
        can(key, projectSlug) {
            if (can(v.perms, key)) return true
            const id = projectSlug ? ids.get(projectSlug) : undefined
            return id !== undefined && canProject(v.perms, scope, key, id)
        },
    }
    return next({ ctx: { ...ctx, perms } })
})
const canDo = (ctx: unknown, key: string, projectSlug?: string) => { try { requirePerm(ctx, key, projectSlug); return true } catch { return false } }

type Row = Record<string, unknown>
const plain = (v: unknown): unknown => (typeof v === 'bigint' ? Number(v) : v)
/** Raw read; a table the CLI has not created yet is just empty. */
async function q(db: PrismaClient, sql: string, ...params: unknown[]): Promise<Row[]> {
    try {
        const rows = (await db.$queryRawUnsafe(sql, ...params)) as Row[]
        return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, plain(v)])))
    } catch (e) {
        if (/no such table/i.test((e as Error).message)) return []
        throw e
    }
}
const n = (v: unknown) => Number(v ?? 0)
const slug = z.string().regex(/^[\w.-]{1,60}$/)
const repoName = z.string().regex(/^[\w.-]+\/[\w.-]+$/)

const verdict = (r: Row) => (r.status === 'completed' ? String(r.conclusion || 'unknown') : r.status === 'in_progress' ? 'running' : String(r.status || 'unknown'))

const ci = router({
    runs: procedure.input(z.object({ project: slug.optional(), repo: repoName.optional(), status: z.string().max(20).optional(), limit: z.number().int().min(1).max(500).default(100) })).query(async ({ ctx, input }) => {
        requirePerm(ctx, 'automation.view', input.project)
        const where: string[] = []; const args: unknown[] = []
        if (input.repo) { where.push('repo = ?'); args.push(input.repo) }
        else if (input.project) { where.push('(repo LIKE ? OR repo = ?)'); args.push(`%/${input.project}`, input.project) }
        const rows = await q(ctx.db, `SELECT * FROM ci_run ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`, ...args, input.limit)
        const mapped = rows.map((r) => ({ source: String(r.source), repo: String(r.repo), runId: String(r.run_id), workflow: String(r.workflow), branch: String(r.branch), sha: String(r.sha).slice(0, 8), verdict: verdict(r), event: String(r.event), title: String(r.title), url: String(r.url), createdAt: n(r.created_at), updatedAt: n(r.updated_at) }))
        return input.status ? mapped.filter((r) => r.verdict === input.status) : mapped
    }),
    repos: procedure.query(async ({ ctx }) => {
        requirePerm(ctx, 'automation.view')
        const rows = await q(ctx.db, 'SELECT * FROM ci_repo ORDER BY repo')
        const mayAct = canDo(ctx, 'automation.edit')
        return { mayAct, repos: rows.map((r) => ({ repo: String(r.repo), source: String(r.source), fetchedAt: n(r.fetched_at), error: String(r.error), runs: n(r.runs) })) }
    }),
    sync: procedure.input(z.object({ repo: repoName.optional(), force: z.boolean().default(true) })).mutation(async ({ ctx, input }) => {
        requirePerm(ctx, 'automation.view')
        return cli('ci', 'sync', ...(input.repo ? ['--repo', input.repo] : []), ...(input.force ? ['--force'] : []))
    }),
    act: procedure.input(z.object({ action: z.enum(['rerun', 'cancel']), repo: repoName, runId: z.string().regex(/^\d+$/) })).mutation(async ({ ctx, input }) => {
        requirePerm(ctx, 'automation.edit', input.repo.split('/')[1])
        return cli('ci', input.action, input.repo, input.runId)
    }),
})

const checks = router({
    list: procedure.query(async ({ ctx }) => {
        requirePerm(ctx, 'automation.view')
        const scripts = await q(ctx.db, 'SELECT * FROM check_script ORDER BY name')
        const last = await q(ctx.db, 'SELECT r.* FROM check_run r JOIN (SELECT name, max(id) id FROM check_run GROUP BY name) m ON m.id = r.id')
        const lastBy = new Map(last.map((r) => [String(r.name), r]))
        const items = await ctx.db.item.findMany({ where: { kind: 'check' }, orderBy: { key: 'asc' }, select: { key: true, title: true, status: true, cadence: true, lastRunAt: true } })
        return {
            mayEdit: canDo(ctx, 'automation.edit'),
            scripts: scripts.map((s) => { const l = lastBy.get(String(s.name)); return { name: String(s.name), script: String(s.script), args: String(s.args), intervalMin: n(s.interval_min), enabled: !!n(s.enabled), itemKey: String(s.item_key), note: String(s.note), last: l ? { id: n(l.id), status: String(l.status), startedAt: n(l.started_at), flags: n(l.flags) } : null } }),
            items,
        }
    }),
    available: procedure.query(async ({ ctx }) => { requirePerm(ctx, 'automation.view'); return JSON.parse((await cli('check', 'scripts', '--json')) || '[]') as { name: string; script: string; description: string; configured: boolean }[] }),
    runs: procedure.input(z.object({ name: z.string().max(80).optional(), limit: z.number().int().min(1).max(100).default(30) })).query(async ({ ctx, input }) => {
        requirePerm(ctx, 'automation.view')
        const rows = await q(ctx.db, `SELECT id, name, started_at, finished_at, exit_code, status, trigger, output, flags FROM check_run ${input.name ? 'WHERE name = ?' : ''} ORDER BY id DESC LIMIT ?`, ...(input.name ? [input.name] : []), input.limit)
        return rows.map((r) => ({ id: n(r.id), name: String(r.name), startedAt: n(r.started_at), finishedAt: r.finished_at == null ? null : n(r.finished_at), exitCode: r.exit_code == null ? null : n(r.exit_code), status: String(r.status), trigger: String(r.trigger), output: String(r.output), flags: n(r.flags) }))
    }),
    save: procedure.input(z.object({ name: z.string().regex(/^[\w-]{1,60}$/), isNew: z.boolean(), script: z.string().regex(/^chk-[\w-]+\.sh$/), args: z.string().max(300).default(''), intervalMin: z.number().int().min(0).max(525600).default(0), enabled: z.boolean().default(true), itemKey: z.string().max(40).default(''), note: z.string().max(500).default('') })).mutation(({ ctx, input }) => {
        requirePerm(ctx, 'automation.edit')
        return cli('check', input.isNew ? 'add' : 'edit', input.name, '--script', input.script, '--args', input.args, '--interval', String(input.intervalMin), '--item', input.itemKey, '--note', input.note, ...(input.enabled ? [] : ['--disable']))
    }),
    remove: procedure.input(z.object({ name: z.string().max(80) })).mutation(({ ctx, input }) => { requirePerm(ctx, 'automation.edit'); return cli('check', 'rm', input.name) }),
    run: procedure.input(z.object({ name: z.string().max(80) })).mutation(({ ctx, input }) => { requirePerm(ctx, 'automation.edit'); return cli('check', 'run', input.name) }),
    due: procedure.input(z.object({ key: z.string().max(40) })).mutation(({ ctx, input }) => { requirePerm(ctx, 'automation.edit'); return cli('check', 'due', input.key) }),
})

const gh = router({
    /** Latest sample per bucket, the warning flag, the warn threshold and the recent history. */
    state: procedure.input(z.object({ hours: z.number().int().min(1).max(720).default(48) })).query(async ({ ctx, input }) => {
        requirePerm(ctx, 'usage.view')
        const since = Date.now() - input.hours * 3_600_000
        const warn = Number((await ctx.db.setting.findUnique({ where: { key: 'ghWarnPct' } }))?.value ?? 20)
        const latest = await q(ctx.db, 'SELECT r.* FROM gh_rate r JOIN (SELECT bucket, max(id) id FROM gh_rate GROUP BY bucket) m ON m.id = r.id')
        const history = await q(ctx.db, 'SELECT ts, bucket, "limit", remaining, reset FROM gh_rate WHERE ts >= ? ORDER BY ts', since)
        const callers = await q(ctx.db, 'SELECT caller, bucket, count(*) calls, sum(limited) limited, sum(skipped) skipped, sum(waited_ms) waited_ms FROM gh_call WHERE ts >= ? GROUP BY caller, bucket ORDER BY calls DESC', since)
        const buckets = latest.map((r) => { const limit = n(r.limit); const remaining = n(r.remaining); return { bucket: String(r.bucket), limit, remaining, pct: limit ? Math.round((remaining / limit) * 100) : 100, reset: n(r.reset) * (n(r.reset) < 1e12 ? 1000 : 1), at: n(r.ts) } })
        return {
            warnPct: warn, buckets, low: buckets.filter((b) => b.pct <= warn),
            history: history.map((r) => ({ ts: n(r.ts), bucket: String(r.bucket), used: n(r.limit) - n(r.remaining), remaining: n(r.remaining), limit: n(r.limit) })),
            callers: callers.map((r) => ({ caller: String(r.caller), bucket: String(r.bucket), calls: n(r.calls), limited: n(r.limited), skipped: n(r.skipped), waitedMs: n(r.waited_ms) })),
        }
    }),
    calls: procedure.input(z.object({ limit: z.number().int().min(1).max(500).default(100) })).query(async ({ ctx, input }) => {
        requirePerm(ctx, 'usage.view')
        const rows = await q(ctx.db, 'SELECT * FROM gh_call ORDER BY id DESC LIMIT ?', input.limit)
        return rows.map((r) => ({ id: n(r.id), ts: n(r.ts), caller: String(r.caller), bucket: String(r.bucket), cmd: String(r.cmd), status: n(r.status), ms: n(r.ms), limited: !!n(r.limited), skipped: !!n(r.skipped), waitedMs: n(r.waited_ms) }))
    }),
    sample: procedure.mutation(({ ctx }) => { requirePerm(ctx, 'usage.view'); return cli('gh', 'sample') }),
})

const jobRow = (r: Row) => ({ id: n(r.id), kind: String(r.kind), project: String(r.project), target: String(r.target), node: String(r.node), status: String(r.status), params: String(r.params), requestedBy: String(r.requested_by), createdAt: n(r.created_at), startedAt: r.started_at == null ? null : n(r.started_at), finishedAt: r.finished_at == null ? null : n(r.finished_at), result: String(r.result), log: String(r.log) })

const offload = router({
    list: procedure.input(z.object({ project: slug.optional(), limit: z.number().int().min(1).max(200).default(30) })).query(async ({ ctx, input }) => {
        requirePerm(ctx, 'tools.view', input.project)
        const rows = await q(ctx.db, `SELECT id, kind, project, target, node, status, params, requested_by, created_at, started_at, finished_at, result, '' log FROM offload_job ${input.project ? 'WHERE project = ?' : ''} ORDER BY id DESC LIMIT ?`, ...(input.project ? [input.project] : []), input.limit)
        return { mayTrigger: canDo(ctx, 'playtest.trigger', input.project), jobs: rows.map(jobRow) }
    }),
    job: procedure.input(z.object({ id: z.number().int() })).query(async ({ ctx, input }) => {
        const r = (await q(ctx.db, 'SELECT * FROM offload_job WHERE id = ?', input.id))[0]
        if (!r) throw new TRPCError({ code: 'NOT_FOUND', message: 'no such job' })
        requirePerm(ctx, 'tools.view', String(r.project))
        return jobRow(r)
    }),
    trigger: procedure.input(z.object({ project: slug, target: z.enum(['planet', 'station']), map: z.string().max(60).default(''), bots: z.number().int().min(1).max(64).default(4), duration: z.number().int().min(10).max(3600).default(60) })).mutation(async ({ ctx, input }) => {
        requirePerm(ctx, 'playtest.trigger', input.project)
        const by = ctx.viewer.username
        const out = await cli('offload', 'start', 'playtest', '--project', input.project, '--target', input.target, '--map', input.map, '--bots', String(input.bots), '--duration', String(input.duration), '--by', by, '--json')
        return JSON.parse(out) as { id: number; node: string; status: string }
    }),
})

/** Playtest <-> perf-run link: `nightly playtest import-perf` records a playtest (source=perf-run) at the run's `ranAt`, so the pair is (game, at). */
const links = router({
    forGame: procedure.input(z.object({ game: slug.optional(), limit: z.number().int().min(1).max(200).default(60) })).query(async ({ ctx, input }) => {
        requirePerm(ctx, 'tools.view', input.game)
        const where = input.game ? { game: input.game } : {}
        const [runs, tests] = await Promise.all([
            ctx.db.perfRun.findMany({ where, orderBy: { ranAt: 'desc' }, take: input.limit, select: { id: true, game: true, name: true, label: true, map: true, bots: true, platform: true, commit: true, ranAt: true } }),
            ctx.db.playtest.findMany({ where, orderBy: { at: 'desc' }, take: input.limit * 2 }),
        ])
        const byAt = new Map(tests.filter((t) => t.tester === 'bots').map((t) => [`${t.game}|${t.at.getTime()}`, t]))
        const used = new Set<number>()
        const perf = runs.map((r) => { const t = byAt.get(`${r.game}|${r.ranAt.getTime()}`); if (t) used.add(t.id); return { ...r, playtestId: t?.id ?? null } })
        const rev = new Map(perf.filter((p) => p.playtestId).map((p) => [p.playtestId, p.id]))
        return {
            perf,
            playtests: tests.map((t) => ({ id: t.id, game: t.game, build: t.build, tester: t.tester, rating: t.rating, tags: t.tags, text: t.text, at: t.at, automatic: t.tester === 'bots', perfRunId: rev.get(t.id) ?? null })),
        }
    }),
    games: procedure.query(async ({ ctx }) => {
        const rows = await ctx.db.perfGame.findMany({ select: { slug: true, name: true }, orderBy: { slug: 'asc' } })
        return rows
    }),
})

export const opsRouter = router({ ci, checks, gh, offload, links })
