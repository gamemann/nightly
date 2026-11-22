import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
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
/** Open/close the per-check RSI findings of a gate result. */
export async function gateSync(kind: string, game: string, failures: unknown[], infra: boolean) {
    try { return JSON.parse(await cli(['gates', 'sync', '--kind', kind, '--game', game, '--file', '-', '--json', ...(infra ? ['--infra'] : [])], JSON.stringify({ failures }))) } catch { return null }
}

const game = z.string().optional()
export const feedRouter = router({
    releases: procedure.input(z.object({ game })).query(({ ctx, input }) => ctx.db.release.findMany({ where: input.game ? { game: input.game } : {}, orderBy: { at: 'desc' }, take: 200 })),
    crashes: procedure.input(z.object({ game, status: z.string().optional() })).query(({ ctx, input }) =>
        ctx.db.crashGroup.findMany({ where: { ...(input.game ? { game: input.game } : {}), ...(input.status ? { status: input.status } : {}) }, orderBy: [{ status: 'asc' }, { count: 'desc' }], take: 200 })),
    webBudgets: procedure.query(({ ctx }) => ctx.db.webBudget.findMany({ orderBy: [{ game: 'asc' }, { metric: 'asc' }] })),
    webSeries: procedure.input(z.object({ game })).query(({ ctx, input }) => ctx.db.webSample.findMany({ where: input.game ? { game: input.game } : {}, orderBy: { at: 'desc' }, take: 1500 })),
    playtests: procedure.input(z.object({ game })).query(({ ctx, input }) => ctx.db.playtest.findMany({ where: input.game ? { game: input.game } : {}, orderBy: { at: 'desc' }, take: 200 })),
    content: procedure.input(z.object({ game })).query(({ ctx, input }) => ctx.db.contentStat.findMany({ where: input.game ? { game: input.game } : {}, orderBy: [{ game: 'asc' }, { category: 'asc' }, { name: 'asc' }], take: 1000 })),
    setBudget: procedure.input(z.object({ game: z.string().min(1), metric: z.string().min(1), max: z.number(), unit: z.string().default('') })).mutation(({ input }) =>
        cli(['web', 'budget', '--game', input.game, '--metric', input.metric, '--max', String(input.max), '--unit', input.unit, '--json'])),
    setCrash: procedure.input(z.object({ game: z.string(), signature: z.string(), status: z.enum(['open', 'fixed', 'ignored']) })).mutation(({ input }) =>
        cli(['crash', 'set', '--game', input.game, '--signature', input.signature, '--status', input.status, '--json'])),
    kinds: procedure.query(() => [...FEED_KINDS]),
})
