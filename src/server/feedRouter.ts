import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import type { ContentStat, CrashGroup, Playtest, Release } from '../../generated/prisma/client'
import { FEED_SPECS, type FeedName } from '~/lib/feedSpecs'
import { likeEsc, offsetOf, paged, type PageSpec } from '~/lib/paging'
import { pageIn, type PageIn } from './pageInput'
import { procedure, router } from './trpc'

// Health feeds (releases, crashes, web budgets, playtests, content stats). Reads go through Prisma; every write is `bin/nightly` (one writer, one set of rules).
const execp = promisify(execFile)
const FEED_KINDS = ['release', 'crash', 'web', 'playtest', 'content'] as const
async function cli(args: string[], input?: string, token = '') {
    try {
        const p = execp(path.join(process.cwd(), 'bin', 'nightly'), args, { timeout: 60_000, env: { ...process.env, ...(token ? { NIGHTLY_PERF_TOKEN: token } : {}) }, maxBuffer: 16 << 20 })
        if (input !== undefined) p.child.stdin?.end(input)
        return (await p).stdout.trim()
    } catch (e) {
        const err = e as { stderr?: string; message: string }
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err.stderr || err.message).replace(/^nightly: /, '').trim() })
    }
}
/** HTTP ingest of one record or an array. `token` (Bearer) goes through the environment, never argv. */
export const feedIngest = (kind: string, body: string, token: string, viaCookie: boolean) =>
    cli(['feed', 'add', kind, '-', '--json', viaCookie ? '--require-token' : '--token-only'], body, token)
export const agentHeartbeat = (args: string[], token: string) => cli(args, undefined, token)
/** Agents a configured source says are running but that never registered (settings agentSourceCmd / agentSourceFile). */
export const runningUnregistered = async () => JSON.parse(await cli(['agent', 'running', '--json'])) as { configured: boolean; error?: string; agents: { name: string; task: string; since?: string }[] }
/** Open/close the per-check RSI findings of a gate result. */
export async function gateSync(kind: string, game: string, failures: unknown[], infra: boolean) {
    try { return JSON.parse(await cli(['gates', 'sync', '--kind', kind, '--game', game, '--file', '-', '--json', ...(infra ? ['--infra'] : [])], JSON.stringify({ failures }))) } catch { return null }
}

type Delegate = {
    count(a: { where: object }): Promise<number>
    findMany(a: { where: object; orderBy: object[]; skip: number; take: number }): Promise<unknown[]>
    groupBy(a: { by: string[]; where?: object }): Promise<Record<string, unknown>[]>
}
/** One paged feed: filters, search, sort and counts all in SQL; facets are the distinct values of each filter column. */
async function feedPage<T>(d: Delegate, name: Exclude<FeedName, 'web'>, search: string[], input: PageIn, tiebreak = 'id') {
    const spec: PageSpec = FEED_SPECS[name]
    const w: object[] = []
    for (const k of spec.filters ?? []) if (input.f[k]) w.push({ [k]: input.f[k] })
    const q = input.q?.trim()
    if (q) w.push({ OR: search.map((c) => ({ [c]: { contains: q } })) })
    const where = w.length ? { AND: w } : {}
    const sort = spec.sorts.includes(input.sort) ? input.sort : spec.sort
    const total = await d.count({ where })
    const rows = (await d.findMany({ where, orderBy: [{ [sort]: input.dir }, { [tiebreak]: 'desc' }], skip: offsetOf(total, input), take: input.size })) as T[]
    const facets: Record<string, string[]> = {}
    await Promise.all((spec.filters ?? []).map(async (k) => { facets[k] = (await d.groupBy({ by: [k] })).map((r) => String(r[k])).sort() }))
    return { page: paged(rows, total, input), facets }
}

const CI = ['unknown', 'pending', 'passing', 'failing'] as const
const relKey = z.object({ repo: z.string().min(1), version: z.string().min(1), channel: z.string().min(1).default('stable') })
const nn = (v: unknown) => Number(v ?? 0)
type WebRow = { game: string; metric: string; latest: number | null; at: unknown; max: number | null; unit: string | null }
export const feedRouter = router({
    releases: procedure.input(pageIn).query(({ ctx, input }) => feedPage<Release>(ctx.db.release as unknown as Delegate, 'releases', ['repo', 'version', 'game', 'changelog', 'deployedTo'], input)),
    crashes: procedure.input(pageIn).query(({ ctx, input }) => feedPage<CrashGroup>(ctx.db.crashGroup as unknown as Delegate, 'crashes', ['signature', 'game', 'sample', 'version'], input)),
    playtests: procedure.input(pageIn).query(({ ctx, input }) => feedPage<Playtest>(ctx.db.playtest as unknown as Delegate, 'playtests', ['text', 'tags', 'build', 'tester', 'game'], input)),
    content: procedure.input(pageIn).query(({ ctx, input }) => feedPage<ContentStat>(ctx.db.contentStat as unknown as Delegate, 'content', ['name', 'metric', 'category', 'game'], input)),
    /** One row per game/metric series: the newest value, its budget and the last 30 samples, paged in SQL (a window function picks the newest). */
    web: procedure.input(pageIn).query(async ({ ctx, input }) => {
        const w: string[] = [], a: unknown[] = []
        if (input.f.game) { w.push('k.game = ?'); a.push(input.f.game) }
        if (input.f.state === 'over') w.push('r.value > b.max')
        if (input.f.state === 'ok') w.push('(r.value IS NULL OR b.max IS NULL OR r.value <= b.max)')
        const q = input.q?.trim()
        if (q) { w.push("(k.game LIKE ? ESCAPE '\\' OR k.metric LIKE ? ESCAPE '\\')"); a.push(`%${likeEsc(q)}%`, `%${likeEsc(q)}%`) }
        const where = w.length ? `WHERE ${w.join(' AND ')}` : ''
        const from = `FROM (SELECT game, metric FROM WebSample GROUP BY game, metric UNION SELECT game, metric FROM WebBudget) k
            LEFT JOIN (SELECT game, metric, value, at, ROW_NUMBER() OVER (PARTITION BY game, metric ORDER BY at DESC, id DESC) rn FROM WebSample) r ON r.game = k.game AND r.metric = k.metric AND r.rn = 1
            LEFT JOIN WebBudget b ON b.game = k.game AND b.metric = k.metric ${where}`
        const total = nn((await ctx.db.$queryRawUnsafe<{ c: unknown }[]>(`SELECT COUNT(*) c ${from}`, ...a))[0].c)
        const order = { key: 'k.game, k.metric', latest: 'r.value', budget: 'b.max', at: 'r.at' }[FEED_SPECS.web.sorts.includes(input.sort as 'key') ? input.sort : 'key'] ?? 'k.game, k.metric'
        const dir = input.dir === 'desc' ? 'DESC' : 'ASC'
        const rows = await ctx.db.$queryRawUnsafe<WebRow[]>(
            `SELECT k.game, k.metric, r.value latest, r.at, b.max, b.unit ${from} ORDER BY ${order.split(',').map((c) => `${c.trim()} ${dir}`).join(', ')}, k.game, k.metric LIMIT ? OFFSET ?`, ...a, input.size, offsetOf(total, input))
        const games = [...new Set(rows.map((r) => r.game))]
        const hist = games.length ? await ctx.db.$queryRawUnsafe<{ game: string; metric: string; value: number }[]>(
            `SELECT game, metric, value FROM (SELECT game, metric, value, ROW_NUMBER() OVER (PARTITION BY game, metric ORDER BY at DESC, id DESC) rn FROM WebSample WHERE game IN (${games.map(() => '?').join(',')})) WHERE rn <= 30 ORDER BY rn DESC`, ...games) : []
        const trend = new Map<string, number[]>()
        for (const h of hist) { const k = `${h.game}/${h.metric}`; trend.set(k, [...(trend.get(k) ?? []), h.value]) }
        const out = rows.map((r) => ({ key: `${r.game}/${r.metric}`, game: r.game, metric: r.metric, latest: r.latest, at: r.at == null ? null : new Date(r.at as number | string), max: r.max, unit: r.unit ?? '', trend: trend.get(`${r.game}/${r.metric}`) ?? [] }))
        const gs = await ctx.db.$queryRawUnsafe<{ game: string }[]>('SELECT game FROM WebSample GROUP BY game UNION SELECT game FROM WebBudget')
        return { page: paged(out, total, input), facets: { game: gs.map((g) => g.game).sort() } }
    }),
    setBudget: procedure.input(z.object({ game: z.string().min(1), metric: z.string().min(1), max: z.number(), unit: z.string().default('') })).mutation(({ input }) =>
        cli(['web', 'budget', '--game', input.game, '--metric', input.metric, '--max', String(input.max), '--unit', input.unit, '--json'])),
    setCrash: procedure.input(z.object({ game: z.string(), signature: z.string(), status: z.enum(['open', 'fixed', 'ignored']) })).mutation(({ input }) =>
        cli(['crash', 'set', '--game', input.game, '--signature', input.signature, '--status', input.status, '--json'])),
    /** Release writes: the same `nightly releases ...` commands an agent uses, so the panel and the CLI share lib/feeds.mjs. */
    releaseAdd: procedure.input(relKey.extend({ ci: z.enum(CI).default('unknown'), changelog: z.string().default(''), rollback: z.string().default(''), deployedTo: z.string().default(''), game: z.string().default('') })).mutation(({ input }) =>
        cli(['releases', 'add', '--repo', input.repo, '--version', input.version, '--channel', input.channel, '--ci', input.ci, '--changelog', input.changelog, '--rollback', input.rollback, '--deployed-to', input.deployedTo, '--game', input.game, '--json'])),
    releaseSet: procedure.input(relKey.extend({ ci: z.enum(CI).optional(), changelog: z.string().optional(), rollback: z.string().optional() })).mutation(({ input }) =>
        cli(['releases', 'set', '--repo', input.repo, '--version', input.version, '--channel', input.channel, ...(['ci', 'changelog', 'rollback'] as const).flatMap((k) => (input[k] === undefined ? [] : [`--${k}`, input[k] as string])), '--json'])),
    releaseDeploy: procedure.input(relKey.extend({ to: z.string().min(1) })).mutation(({ input }) =>
        cli(['releases', 'deploy', '--repo', input.repo, '--version', input.version, '--channel', input.channel, '--to', input.to, '--json'])),
    releaseUndeploy: procedure.input(relKey.extend({ from: z.string().min(1) })).mutation(({ input }) =>
        cli(['releases', 'undeploy', '--repo', input.repo, '--version', input.version, '--channel', input.channel, '--from', input.from, '--json'])),
    releaseRemove: procedure.input(relKey).mutation(({ input }) => cli(['releases', 'rm', '--repo', input.repo, '--version', input.version, '--channel', input.channel, '--json'])),
    releasesSync: procedure.mutation(() => cli(['releases', 'sync', '--json'])),
    unregistered: procedure.query(() => runningUnregistered()),
    kinds: procedure.query(() => [...FEED_KINDS]),
})
