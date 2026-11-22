import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { chConfig, chPing, chQuery, publicConfig } from '../../lib/usage-ch.mjs'
import { type Backend, breakdown, insights, series, sessions, totals } from '../../lib/usage-query.mjs'
import { parsePrices } from '../../lib/usage-price.mjs'
import { paged, offsetOf } from '../lib/paging'
import { procedure, router } from './trpc'

// Reads only: Prisma raw SQL on the local usage tables, or ClickHouse over HTTP when it is enabled and reachable. Every write
// (ingest, schema) is `bin/nightly usage ...`. The panel never opens SQLite itself and never sees the ClickHouse password's value.
const execp = promisify(execFile)
const DEFAULTS = { usageDirs: '', usageProjectMode: 'basename', usageAutoIngestMinutes: '0', usagePollMin: '8', usageBigResultTokens: '8000', usagePrices: '' }
const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d)

export async function usageIngest(args: string[] = []) {
    try {
        const p = await execp(path.join(process.cwd(), 'bin', 'nightly'), ['usage', 'ingest', '--json', ...args], { timeout: 10 * 60_000, maxBuffer: 8 << 20 })
        return JSON.parse(p.stdout) as { files: number; changed: number; messages: number; tools: number; events: number; chError?: string }
    } catch (e) {
        const err = e as { stderr?: string; message: string }
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err.stderr || err.message).replace(/^nightly: /, '').trim() })
    }
}

const cache = new Map<string, { at: number; v: unknown }>()
async function cached<T>(key: string, fn: () => Promise<T>, ttl = 10_000): Promise<T> {
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < ttl) return hit.v as T
    const v = await fn()
    cache.set(key, { at: Date.now(), v })
    if (cache.size > 200) cache.clear()
    return v
}

type Ctx = { db: import('../../generated/prisma/client').PrismaClient }
async function settings(ctx: Ctx) {
    const rows = await ctx.db.setting.findMany({ where: { key: { startsWith: 'usage' } } })
    return { ...DEFAULTS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) } as Record<string, string>
}
const hasTables = async (ctx: Ctx) => ((await ctx.db.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('usage_message','usage_tool','usage_event')`)) as { n: bigint }[])[0]?.n === 3n

/** ClickHouse when enabled and answering, else the local copy. `source` forces one (an unreachable forced ClickHouse is an error, not a silent fallback). */
async function backend(ctx: Ctx, source: 'auto' | 'sqlite' | 'ch') {
    const s = await settings(ctx)
    const cfg = chConfig((k) => s[k] ?? null)
    if (source !== 'sqlite' && cfg.enabled) {
        try {
            await cached('ping', () => chPing(cfg, { timeoutMs: 3000 }), 15_000)
            const be: Backend = { dialect: 'ch', db: cfg.db, q: (sql) => chQuery(cfg, sql, { timeoutMs: 20_000 }) }
            return { be, kind: 'ch' as const, s, cfg, chError: null as string | null }
        } catch (e) {
            if (source === 'ch') throw new TRPCError({ code: 'BAD_REQUEST', message: (e as Error).message })
            return local(ctx, s, cfg, (e as Error).message)
        }
    }
    if (source === 'ch') throw new TRPCError({ code: 'BAD_REQUEST', message: 'ClickHouse is not enabled (usageChEnabled)' })
    return local(ctx, s, cfg, null)
}
async function local(ctx: Ctx, s: Record<string, string>, cfg: ReturnType<typeof chConfig>, chError: string | null) {
    if (!(await hasTables(ctx))) return { be: null, kind: 'none' as const, s, cfg, chError }
    const be: Backend = { dialect: 'sqlite', q: (sql) => ctx.db.$queryRawUnsafe(sql) as Promise<Record<string, any>[]> }
    return { be, kind: 'sqlite' as const, s, cfg, chError }
}
const prices = (s: Record<string, string>) => {
    try { return parsePrices(s.usagePrices) } catch (e) { throw new TRPCError({ code: 'BAD_REQUEST', message: `usagePrices: ${(e as Error).message}` }) }
}
const since = (days: number) => (days > 0 ? Date.now() - days * 86_400_000 : 0)
const common = z.object({ source: z.enum(['auto', 'sqlite', 'ch']).default('auto'), days: z.number().int().min(0).max(3650).default(30) })

export const usageRouter = router({
    /** Everything the setup / "not configured" state needs; never the password. */
    state: procedure.query(async ({ ctx }) => {
        const b = await backend(ctx, 'auto')
        let rows = { messages: 0, tools: 0, events: 0 }
        if (b.kind !== 'none') {
            const r = (await ctx.db.$queryRawUnsafe(`SELECT (SELECT COUNT(*) FROM usage_message) AS m, (SELECT COUNT(*) FROM usage_tool) AS t, (SELECT COUNT(*) FROM usage_event) AS e`)) as { m: bigint; t: bigint; e: bigint }[]
            rows = { messages: Number(r[0].m), tools: Number(r[0].t), events: Number(r[0].e) }
        }
        const last = await ctx.db.setting.findUnique({ where: { key: 'usageLastIngestAt' } })
        return {
            source: b.kind, tables: b.kind !== 'none', rows, lastIngestAt: last?.value ?? null, clickhouse: publicConfig(b.cfg), chError: b.chError,
            settings: b.s, prices: prices(b.s),
        }
    }),
    overview: procedure.input(common.extend({ unit: z.enum(['day', 'hour']).default('day') })).query(async ({ ctx, input }) => {
        const b = await backend(ctx, input.source)
        if (!b.be) return null
        const p = prices(b.s), be = b.be
        return cached(`ov:${b.kind}:${input.unit}:${input.days}:${b.s.usagePrices}`, async () => {
            const [t, ser, ins] = await Promise.all([
                totals(be, p), series(be, p, { unit: input.unit, since: since(input.unit === 'hour' ? Math.min(input.days || 7, 14) : input.days) }),
                insights(be, p, { since: since(input.days), pollMin: num(b.s.usagePollMin, 8), bigResultTokens: num(b.s.usageBigResultTokens, 8000) }),
            ])
            return { source: b.kind, totals: t, series: ser, insights: ins }
        })
    }),
    /** One dimension's rows (the aggregate is cached), sorted and cut to a page on the server. */
    breakdown: procedure.input(common.extend({ dim: z.string(), filter: z.record(z.string(), z.string()).optional(), page: z.number().int().min(1).default(1), size: z.number().int().min(1).max(1000).default(100), sort: z.string().default('total'), dir: z.enum(['asc', 'desc']).default('desc') })).query(async ({ ctx, input }) => {
        const b = await backend(ctx, input.source)
        if (!b.be) return null
        const be = b.be
        try {
            const r = await cached(`bd:${b.kind}:${input.dim}:${input.days}:${JSON.stringify(input.filter)}:${b.s.usagePrices}`, () => breakdown(be, prices(b.s), input.dim, { since: since(input.days), filter: input.filter }))
            const all = [...r.rows] as Record<string, number | string>[]
            const key = all[0] && input.sort in all[0] ? input.sort : 'total'
            const sgn = input.dir === 'asc' ? 1 : -1
            all.sort((a, c) => (typeof a[key] === 'string' ? String(a[key]).localeCompare(String(c[key])) : Number(a[key] ?? 0) - Number(c[key] ?? 0)) * sgn)
            const off = offsetOf(all.length, input)
            return { ...r, rows: undefined, page: paged(all.slice(off, off + input.size), all.length, input) }
        }
        catch (e) { throw new TRPCError({ code: 'BAD_REQUEST', message: (e as Error).message }) }
    }),
    /** Sessions, newest first, a page at a time (the full aggregate is cached, not capped). */
    sessions: procedure.input(common.extend({ filter: z.record(z.string(), z.string()).optional(), page: z.number().int().min(1).default(1), size: z.number().int().min(1).max(1000).default(100) })).query(async ({ ctx, input }) => {
        const b = await backend(ctx, input.source)
        if (!b.be) return null
        const be = b.be
        try {
            const all = await cached(`ss:${b.kind}:${input.days}:${JSON.stringify(input.filter)}:${b.s.usagePrices}`, () => sessions(be, prices(b.s), { since: since(input.days), filter: input.filter, limit: Infinity }))
            const off = offsetOf(all.length, input)
            return paged(all.slice(off, off + input.size), all.length, input)
        }
        catch (e) { throw new TRPCError({ code: 'BAD_REQUEST', message: (e as Error).message }) }
    }),
    /** Nightly's own scheduled runs (the Run table): turns, minutes and cost the runner recorded. */
    runs: procedure.input(z.object({ days: z.number().int().min(0).max(3650).default(30) })).query(async ({ ctx, input }) => {
        // Folded by day in SQL (startedAt is ISO text, so its first 10 characters are the UTC day): no Run row crosses into JS.
        const rows = await ctx.db.$queryRawUnsafe<{ day: string | null; runs: unknown; turns: unknown; minutes: unknown; costUsd: unknown }[]>(
            `SELECT substr(startedAt, 1, 10) AS day, COUNT(*) AS runs, COALESCE(SUM(turns), 0) AS turns, COALESCE(SUM(minutes), 0) AS minutes, COALESCE(SUM(costUsd), 0) AS costUsd
             FROM Run ${input.days ? 'WHERE startedAt >= ?' : ''} GROUP BY day ORDER BY day`, ...(input.days ? [new Date(since(input.days)).toISOString()] : []))
        const byDay = rows.map((r) => ({ day: r.day ?? '(unknown)', runs: Number(r.runs), turns: Number(r.turns), minutes: Number(r.minutes), costUsd: Number(r.costUsd) }))
        const total = byDay.reduce((t, d) => ({ runs: t.runs + d.runs, turns: t.turns + d.turns, minutes: t.minutes + d.minutes, costUsd: t.costUsd + d.costUsd }), { runs: 0, turns: 0, minutes: 0, costUsd: 0 })
        return { total, byDay }
    }),
    ingest: procedure.input(z.object({ full: z.boolean().default(false) }).default({ full: false })).mutation(async ({ input }) => {
        cache.clear()
        return usageIngest(input.full ? ['--full'] : [])
    }),
    /** Validates before saving so a typo cannot break every chart. */
    setPrices: procedure.input(z.object({ json: z.string() })).mutation(async ({ ctx, input }) => {
        try { parsePrices(input.json) } catch (e) { throw new TRPCError({ code: 'BAD_REQUEST', message: (e as Error).message }) }
        cache.clear()
        await ctx.db.setting.upsert({ where: { key: 'usagePrices' }, create: { key: 'usagePrices', value: input.json }, update: { value: input.json } })
        return { ok: true }
    }),
})
