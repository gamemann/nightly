import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { TRANSCRIPT_DDL } from '../../lib/transcripts-ddl.mjs'
import { readRange, safePath, roots } from '../../lib/transcripts-files.mjs'
import { renderLine } from '../../lib/transcripts-parse.mjs'
import { procedure, router } from './trpc'
import { getViewer, need, type Viewer } from './transcriptsAccess'

// Reads: Prisma raw SQL on the Transcript tables plus byte-range reads of the jsonl (text is never copied into the database).
// Writes and anything node:sqlite (ingest, runs): `bin/nightly transcript ...`, the panel never opens SQLite itself.
const execp = promisify(execFile)
type Ctx = { db: import('../../generated/prisma/client').PrismaClient }
type Row = Record<string, unknown>
const num = (v: unknown) => Number(v ?? 0)

let ready: Promise<void> | null = null
async function ensure(ctx: Ctx) {
    ready ??= (async () => { for (const s of TRANSCRIPT_DDL) await ctx.db.$executeRawUnsafe(s) })().catch((e) => { ready = null; throw e })
    return ready
}

const bin = () => path.join(process.cwd(), 'bin', 'nightly')
async function cli(args: string[], timeout = 60_000) {
    try {
        const p = await execp(bin(), ['transcript', ...args, '--json'], { timeout, maxBuffer: 16 << 20 })
        return JSON.parse(p.stdout)
    } catch (e) {
        const err = e as { stderr?: string; message: string }
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err.stderr || err.message).replace(/^nightly: /, '').trim().slice(0, 500) })
    }
}

// Background ingest of new session files: at most one at a time, at most every 20 s, never awaited by a request.
let ingesting = false, lastIngest = 0
export function kickIngest() {
    if (ingesting || Date.now() - lastIngest < 20_000) return
    ingesting = true; lastIngest = Date.now()
    execp(bin(), ['transcript', 'ingest', '--json'], { timeout: 20 * 60_000 }).catch(() => undefined).finally(() => { ingesting = false; lastIngest = Date.now() })
}
const lastRefresh = new Map<number, number>()
/** Pull the newest lines of one conversation (and its subagents) into the index; throttled per transcript. */
export async function refreshOne(id: number, minMs = 1500) {
    if (Date.now() - (lastRefresh.get(id) ?? 0) < minMs) return
    lastRefresh.set(id, Date.now())
    if (lastRefresh.size > 500) lastRefresh.clear()
    await execp(bin(), ['transcript', 'refresh', String(id), '--json'], { timeout: 60_000 }).catch(() => undefined)
}

const COLS = 'id,uid,osUser,sessionId,agentId,parentId,agentType,description,title,cwd,projectSlug,gitBranch,model,startedAt,lastAt,messageCount,toolCount,inTokens,outTokens,cacheReadTokens,cacheWriteTokens,status,source'
export type Conv = { id: number; uid: string; osUser: string; sessionId: string; agentId: string; parentId: number | null; agentType: string; description: string; title: string; cwd: string; projectSlug: string; gitBranch: string; model: string; startedAt: string; lastAt: string; messageCount: number; toolCount: number; inTokens: number; outTokens: number; cacheReadTokens: number; cacheWriteTokens: number; status: string; source: string }
const conv = (r: Row) => ({ ...r, id: num(r.id), parentId: r.parentId == null ? null : num(r.parentId), messageCount: num(r.messageCount), toolCount: num(r.toolCount), inTokens: num(r.inTokens), outTokens: num(r.outTokens), cacheReadTokens: num(r.cacheReadTokens), cacheWriteTokens: num(r.cacheWriteTokens) }) as unknown as Conv
const like = (q: string) => `%${q.replace(/[\\%_]/g, '\\$&')}%`

async function load(ctx: Ctx, v: Viewer, id: number) {
    await ensure(ctx)
    const rows = (await ctx.db.$queryRawUnsafe(`SELECT ${COLS},filePath FROM Transcript WHERE id = ?`, id)) as Row[]
    if (!rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'no such transcript' })
    const t = conv(rows[0]) as ReturnType<typeof conv> & { filePath: string }
    t.filePath = String(rows[0].filePath)
    if (!v.canSee(t.osUser)) throw new TRPCError({ code: 'FORBIDDEN', message: 'not your transcript' })
    return t
}

export async function activeRunOf(ctx: Ctx, t: { id: number; sessionId: string }) {
    const r = (await ctx.db.$queryRawUnsafe(`SELECT id,status,pid,model,effort,permissionMode,cwd,osUser,startedAt FROM TranscriptRun WHERE status IN ('starting','running','idle') AND (transcriptId = ? OR sessionId = ?) ORDER BY id DESC LIMIT 1`, t.id, t.sessionId)) as Row[]
    return r[0] ? { ...r[0], id: num(r[0].id), pid: num(r[0].pid) } : null
}

const idIn = z.object({ id: z.number().int().positive() })
const startIn = z.object({
    prompt: z.string().min(1).max(200_000),
    cwd: z.string().min(1).max(1000),
    model: z.string().max(80).optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    mode: z.enum(['default', 'acceptEdits', 'plan', 'auto', 'bypass']).default('default'),
    resumeId: z.number().int().positive().optional(),
    fork: z.boolean().default(false),
})

function flags(o: { model?: string; effort?: string; mode?: string }, v: Viewer) {
    const a = ['--as', v.osUser, '--mode', o.mode ?? 'default']
    if (o.model) a.push('--model', o.model)
    if (o.effort) a.push('--effort', o.effort)
    if (v.userId) a.push('--user-id', String(v.userId))
    return a
}

export const transcriptsRouter = router({
    /** Left list, History popover and search: newest first, main conversations (subagent threads only with `agents`). */
    list: procedure.input(z.object({ q: z.string().max(200).default(''), limit: z.number().int().min(1).max(200).default(40), agents: z.boolean().default(false), osUser: z.string().max(40).optional() }).default({ q: '', limit: 40, agents: false })).query(async ({ ctx, input }) => {
        const v = await getViewer(ctx)
        need(v, 'transcripts.view')
        await ensure(ctx)
        kickIngest()
        const where: string[] = [], args: unknown[] = []
        if (!input.agents) where.push("agentId = ''")
        if (input.osUser) { where.push('osUser = ?'); args.push(input.osUser) }
        if (input.q) { where.push("(title LIKE ? ESCAPE '\\' OR cwd LIKE ? ESCAPE '\\' OR sessionId LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')"); const p = like(input.q); args.push(p, p, p, p) }
        const rows = (await ctx.db.$queryRawUnsafe(`SELECT ${COLS} FROM Transcript ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY lastAt DESC LIMIT ?`, ...args, input.limit)) as Row[]
        const live = (await ctx.db.$queryRawUnsafe(`SELECT transcriptId FROM TranscriptRun WHERE status IN ('starting','running','idle')`)) as Row[]
        const liveIds = new Set(live.map((r) => num(r.transcriptId)))
        return rows.map(conv).filter((r) => v.canSee(r.osUser)).map((r) => ({ ...r, live: liveIds.has(r.id) }))
    }),

    get: procedure.input(idIn).query(async ({ ctx, input }) => {
        const v = await getViewer(ctx)
        need(v, 'transcripts.view')
        await refreshOne(input.id, 3000)
        const { filePath: _f, ...t } = await load(ctx, v, input.id)
        void _f
        return { ...t, run: await activeRunOf(ctx, t as { id: number; sessionId: string }), canRun: v.can('transcripts.run') }
    }),

    /** One page of rendered entries. Newest page by default; `before` (a seq) loads earlier ones; `after` returns only newer. */
    messages: procedure.input(z.object({ id: z.number().int().positive(), before: z.number().int().optional(), after: z.number().int().optional(), limit: z.number().int().min(1).max(300).default(80) })).query(async ({ ctx, input }) => {
        const v = await getViewer(ctx)
        need(v, 'transcripts.view')
        const t = await load(ctx, v, input.id)
        if (input.after === undefined) await refreshOne(input.id)
        const rows = (input.after !== undefined
            ? await ctx.db.$queryRawUnsafe(`SELECT seq,byteStart,byteLen FROM TranscriptMessage WHERE transcriptId = ? AND meta = 0 AND seq > ? ORDER BY seq LIMIT ?`, input.id, input.after, input.limit)
            : await ctx.db.$queryRawUnsafe(`SELECT * FROM (SELECT seq,byteStart,byteLen FROM TranscriptMessage WHERE transcriptId = ? AND meta = 0 AND seq < ? ORDER BY seq DESC LIMIT ?) ORDER BY seq`, input.id, input.before ?? 2_000_000_000, input.limit)) as Row[]
        const file = safePath(t.filePath, roots(String((await ctx.db.setting.findUnique({ where: { key: 'transcriptDirs' } }))?.value ?? '')))
        if (!file) throw new TRPCError({ code: 'NOT_FOUND', message: 'transcript file is gone or outside the allowed directories' })
        const entries = []
        for (const r of rows) {
            const e = renderLine(readRange(file, num(r.byteStart), num(r.byteLen)).toString('utf8'))
            if (e) entries.push({ seq: num(r.seq), ...e })
        }
        const first = rows[0] ? num(rows[0].seq) : null
        const hasMore = input.after === undefined && first !== null
            ? num(((await ctx.db.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM TranscriptMessage WHERE transcriptId = ? AND meta = 0 AND seq < ?`, input.id, first)) as Row[])[0]?.n) > 0
            : false
        return { entries, hasMore, size: statSize(file) }
    }),

    /** The thread and every subagent below it, with who spawned whom, tool usage and tokens (the collaboration view). */
    tree: procedure.input(idIn).query(async ({ ctx, input }) => {
        const v = await getViewer(ctx)
        need(v, 'transcripts.view')
        const t = await load(ctx, v, input.id)
        await refreshOne(input.id)
        const rows = ((await ctx.db.$queryRawUnsafe(`SELECT ${COLS},toolUseId FROM Transcript WHERE sessionId = ? ORDER BY startedAt, id`, t.sessionId)) as Row[]).map(conv)
        const tools = (await ctx.db.$queryRawUnsafe(`SELECT m.transcriptId AS tid, m.tools AS tools FROM TranscriptMessage m JOIN Transcript t ON t.id = m.transcriptId WHERE t.sessionId = ? AND m.tools <> '[]'`, t.sessionId)) as Row[]
        const use = new Map<number, Record<string, number>>()
        for (const r of tools) {
            const m = use.get(num(r.tid)) ?? {}
            try { for (const n of JSON.parse(String(r.tools)) as string[]) m[n] = (m[n] ?? 0) + 1 } catch { /* skip */ }
            use.set(num(r.tid), m)
        }
        const spawns = (await ctx.db.$queryRawUnsafe(`SELECT m.transcriptId AS tid, m.spawnIds AS ids, m.ts AS ts FROM TranscriptMessage m JOIN Transcript t ON t.id = m.transcriptId WHERE t.sessionId = ? AND m.spawnIds <> '[]'`, t.sessionId)) as Row[]
        return { rootId: rows.find((r) => !r.agentId)?.id ?? t.id, nodes: rows.map((r) => ({ ...r, tools: use.get(r.id) ?? {} })), spawns: spawns.length }
    }),

    /** Every subagent thread (the Agents page), with its parent conversation. */
    agents: procedure.input(z.object({ q: z.string().max(200).default(''), limit: z.number().int().min(1).max(300).default(100) }).default({ q: '', limit: 100 })).query(async ({ ctx, input }) => {
        const v = await getViewer(ctx)
        need(v, 'transcripts.view')
        await ensure(ctx)
        kickIngest()
        const args: unknown[] = []
        let w = "a.agentId <> ''"
        if (input.q) { w += " AND (a.description LIKE ? ESCAPE '\\' OR a.agentType LIKE ? ESCAPE '\\' OR p.title LIKE ? ESCAPE '\\')"; const p = like(input.q); args.push(p, p, p) }
        const rows = (await ctx.db.$queryRawUnsafe(`SELECT a.id,a.osUser,a.sessionId,a.agentId,a.parentId,a.agentType,a.description,a.model,a.startedAt,a.lastAt,a.messageCount,a.toolCount,a.inTokens,a.outTokens,a.status,p.title AS parentTitle,p.id AS rootId FROM Transcript a LEFT JOIN Transcript p ON p.sessionId = a.sessionId AND p.agentId = '' WHERE ${w} ORDER BY a.lastAt DESC LIMIT ?`, ...args, input.limit)) as Row[]
        const named = (await ctx.db.$queryRawUnsafe(`SELECT name,status,task,updatedAt FROM Agent ORDER BY updatedAt DESC LIMIT 100`).catch(() => [])) as Row[]
        return { threads: rows.filter((r) => v.canSee(String(r.osUser))).map((r) => ({ ...r, id: num(r.id), parentId: r.parentId == null ? null : num(r.parentId), rootId: r.rootId == null ? null : num(r.rootId), messageCount: num(r.messageCount), toolCount: num(r.toolCount), inTokens: num(r.inTokens), outTokens: num(r.outTokens) }) as unknown as Conv & { rootId: number | null; parentTitle: string | null }), registered: named }
    }),

    /** Start a new conversation (or resume one) and return as soon as the session exists; the page then follows it by SSE. */
    start: procedure.input(startIn).mutation(async ({ ctx, input }) => {
        const v = await getViewer(ctx)
        need(v, 'transcripts.run')
        need(v, 'nodes.use')
        await ensure(ctx)
        const resume = input.resumeId ? (await load(ctx, v, input.resumeId)).sessionId : null
        const args = ['start', '--prompt', '-', '--cwd', input.cwd, ...flags(input, v)]
        if (resume) args.push('--resume', resume)
        if (input.fork) args.push('--fork')
        return runWithStdin(args, input.prompt) as Promise<{ runId: number; transcriptId: number; sessionId: string }>
    }),

    send: procedure.input(z.object({ id: z.number().int().positive(), text: z.string().min(1).max(200_000), model: z.string().max(80).optional(), effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(), mode: z.enum(['default', 'acceptEdits', 'plan', 'auto', 'bypass']).default('default') })).mutation(async ({ ctx, input }) => {
        const v = await getViewer(ctx)
        need(v, 'transcripts.run')
        need(v, 'nodes.use')
        const t = await load(ctx, v, input.id)
        return runWithStdin(['send', String(t.id), '-', ...flags(input, v)], input.text) as Promise<{ runId: number; transcriptId: number; resumed: boolean }>
    }),

    stop: procedure.input(z.object({ id: z.number().int().positive(), interrupt: z.boolean().default(false) })).mutation(async ({ ctx, input }) => {
        const v = await getViewer(ctx)
        need(v, 'transcripts.run')
        const t = await load(ctx, v, input.id)
        return cli(['stop', String(t.id), ...(input.interrupt ? ['--interrupt'] : [])])
    }),

    /** Working directories to offer in the composer: registered project repos, then recent conversation directories. */
    places: procedure.query(async ({ ctx }) => {
        const v = await getViewer(ctx)
        need(v, 'transcripts.view')
        await ensure(ctx)
        const projects = (await ctx.db.$queryRawUnsafe(`SELECT slug,name,repoPath FROM Project WHERE repoPath <> '' AND archived = 0 ORDER BY name`).catch(() => [])) as Row[]
        const recent = (await ctx.db.$queryRawUnsafe(`SELECT cwd, MAX(lastAt) AS last FROM Transcript WHERE agentId = '' AND cwd <> '' GROUP BY cwd ORDER BY last DESC LIMIT 15`)) as Row[]
        return { osUser: v.osUser, canRun: v.can('transcripts.run') && v.can('nodes.use'), projects: projects.map((p) => ({ slug: String(p.slug), name: String(p.name), path: String(p.repoPath) })), recent: recent.map((r) => String(r.cwd)) }
    }),
})

function statSize(file: string) { try { return statSync(file).size } catch { return 0 } }

/** The CLI reads a long prompt from stdin when it is `-`; execFile has no stdin, so spawn through it. */
function runWithStdin(args: string[], input: string) {
    return new Promise((resolve, reject) => {
        const p = execFile(bin(), ['transcript', ...args, '--json'], { timeout: 90_000, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
            if (err) return reject(new TRPCError({ code: 'BAD_REQUEST', message: (stderr || err.message).replace(/^nightly: /, '').trim().slice(0, 500) }))
            try { resolve(JSON.parse(stdout)) } catch { reject(new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'bad CLI output' })) }
        })
        p.stdin?.end(input)
    })
}
