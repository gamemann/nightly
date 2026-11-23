import { z } from 'zod'
import { procedure, router } from './trpc'
import { toolsCli } from './toolsServer'

type Job = { id: number; project: string; input_name: string; from_fmt: string; to_fmt: string; status: string; progress: number; log: string; outputs: string; warnings: string; report: string; error: string; node: string; created_by: string; created_at: string; finished_at: string }
const shape = (j: Job, withLog: boolean) => ({
    id: Number(j.id), project: j.project, input: j.input_name, from: j.from_fmt, to: j.to_fmt, status: j.status, progress: j.progress, node: j.node, by: j.created_by, createdAt: j.created_at, finishedAt: j.finished_at,
    error: j.error, outputs: JSON.parse(j.outputs || '[]') as { name: string; label: string; bytes: number }[], warnings: JSON.parse(j.warnings || '[]') as string[],
    report: JSON.parse(j.report || '{}') as MappingReport, log: withLog ? j.log : '',
})
export type MappingReport = { materials?: { name: string; tris: number; status: 'resolved' | 'generated' | 'unmapped'; texture?: string; credit?: string; asset?: { id: number; pack: string; weaponId: string } | null }[]; counts?: Record<string, number>; models?: unknown[] }
export type JobView = ReturnType<typeof shape>

export const toolsRouter = router({
    /** Registered converters, with the reason one is unavailable on this machine. */
    formats: procedure.query(() => toolsCli(['map-convert', '--formats']) as Promise<{ id: string; from: string; to: string; label: string; note: string; available: string }[]>),
    mapJobs: procedure.input(z.object({ project: z.string().optional() })).query(async ({ ctx, input }) => {
        const rows = await ctx.db.$queryRawUnsafe<Job[]>(`SELECT * FROM map_convert_job ${input.project ? 'WHERE project = ?' : ''} ORDER BY id DESC LIMIT 40`, ...(input.project ? [input.project] : [])).catch(() => [])
        return rows.map((j) => shape(j, false))
    }),
    /** One job with its log and mapping report; poll while status is queued or running. */
    mapJob: procedure.input(z.object({ id: z.number().int() })).query(async ({ ctx, input }) => {
        const rows = await ctx.db.$queryRawUnsafe<Job[]>('SELECT * FROM map_convert_job WHERE id = ?', input.id).catch(() => [])
        return rows[0] ? shape(rows[0], true) : null
    }),
    uploads: procedure.input(z.object({ pack: z.string().optional(), type: z.string().optional() })).query(async ({ ctx, input }) => {
        const w: string[] = [], a: string[] = []
        if (input.pack) { w.push('pack = ?'); a.push(input.pack) }
        if (input.type) { w.push('type = ?'); a.push(input.type) }
        return ctx.db.$queryRawUnsafe<{ id: number; pack: string; type: string; name: string; bytes: number; note: string; project: string; uploadedBy: string; uploadedAt: string }[]>(`SELECT id, pack, type, name, bytes, note, project, uploadedBy, uploadedAt FROM AssetUpload ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id DESC LIMIT 100`, ...a).catch(() => [])
    }),
    /** Upload limits as configured (MB; 0 = unlimited), shown beside the drop zone. */
    limits: procedure.query(async ({ ctx }) => {
        const rows = await ctx.db.setting.findMany({ where: { key: { startsWith: 'uploadMaxMb' } } })
        return Object.fromEntries(rows.map((r) => [r.key, r.value]))
    }),
})
