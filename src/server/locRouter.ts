import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { can, canProject } from '../../lib/permissions.mjs'
import { rollup, type LocLanguage, type LocStats } from '../../lib/loc-core.mjs'
import { assertProject, projectScope } from './projectsRouter'
import { procedure, router } from './trpc'

// Lines of code. Reads the LocStat cache through Prisma; the only writer is `bin/nightly loc` (scc, the cache rows, the
// ClickHouse history), which the rescan mutation shells out to. Reading needs no global permission: a viewer without
// projects.view sees only the projects (and folder totals of those projects) their ProjectAccess rows allow.
const execp = promisify(execFile)

const asStats = (r: { code: number; comments: number; blanks: number; total: number; files: number; byLanguage: string; scannedAt: Date; sha: string }): LocStats & { scannedAt: Date; sha: string } => ({
    code: r.code, comments: r.comments, blanks: r.blanks, total: r.total, files: r.files, byLanguage: JSON.parse(r.byLanguage || '[]') as LocLanguage[], scannedAt: r.scannedAt, sha: r.sha,
})

export const locRouter = router({
    /** Newest stats per visible project (by slug), roll-ups per folder id (visible projects only) and the grand total. */
    overview: procedure.query(async ({ ctx }) => {
        const v = ctx.viewer!
        const [projects, folders, rows] = await Promise.all([
            ctx.db.project.findMany({ select: { id: true, slug: true, folderId: true } }),
            ctx.db.folder.findMany({ select: { id: true, parentId: true } }),
            ctx.db.$queryRawUnsafe('SELECT * FROM LocStat WHERE id IN (SELECT MAX(id) FROM LocStat GROUP BY projectId)') as Promise<(Parameters<typeof asStats>[0] & { projectId: number })[]>,
        ])
        const all = can(v.perms, 'projects.view')
        const scope = all ? null : await projectScope(v)
        const visible = projects.filter((p) => all || canProject(v.perms, scope!, 'projects.view', p.id))
        const ids = new Set(visible.map((p) => p.id))
        const stats = new Map(rows.filter((r) => ids.has(r.projectId)).map((r) => [r.projectId, asStats({ ...r, scannedAt: new Date(r.scannedAt) })]))
        const rolled = rollup(folders, visible, stats)
        const bySlug: Record<string, LocStats & { scannedAt: Date; sha: string }> = {}
        for (const p of visible) { const s = stats.get(p.id); if (s) bySlug[p.slug] = s }
        const total = { code: 0, comments: 0, blanks: 0, total: 0, files: 0, projects: 0 }
        for (const s of stats.values()) { total.code += s.code; total.comments += s.comments; total.blanks += s.blanks; total.total += s.total; total.files += s.files; total.projects++ }
        return { projects: bySlug, folders: Object.fromEntries([...rolled].map(([id, s]) => [id, { code: s.code, comments: s.comments, blanks: s.blanks, total: s.total, files: s.files, projects: s.projects, byLanguage: s.byLanguage }])), total }
    }),
    /** One project: the newest stats and the history (one point per scan or daily snapshot, oldest first). */
    project: procedure.input(z.object({ slug: z.string() })).query(async ({ ctx, input }) => {
        const p = await ctx.db.project.findUnique({ where: { slug: input.slug }, select: { id: true } })
        if (!p) throw new TRPCError({ code: 'NOT_FOUND', message: `no project ${input.slug}` })
        await assertProject(ctx.viewer, 'projects.view', p.id)
        const rows = await ctx.db.locStat.findMany({ where: { projectId: p.id }, orderBy: { id: 'asc' } })
        const last = rows[rows.length - 1]
        return { latest: last ? asStats(last) : null, history: rows.map((r) => ({ at: r.scannedAt, code: r.code, total: r.total, files: r.files, sha: r.sha })) }
    }),
    /** Rescan one project (or all with no slug) through the CLI. force skips the "HEAD unchanged" shortcut. */
    rescan: procedure.input(z.object({ slug: z.string().optional(), force: z.boolean().default(false) })).mutation(async ({ ctx, input }) => {
        if (input.slug) {
            const p = await ctx.db.project.findUnique({ where: { slug: input.slug }, select: { id: true } })
            if (!p) throw new TRPCError({ code: 'NOT_FOUND', message: `no project ${input.slug}` })
            await assertProject(ctx.viewer, 'projects.edit', p.id)
        } else if (!can(ctx.viewer!.perms, 'projects.edit')) throw new TRPCError({ code: 'FORBIDDEN', message: 'missing permission projects.edit' })
        try {
            const { stdout } = await execp(path.join(process.cwd(), 'bin', 'nightly'), ['loc', ...(input.slug ? [input.slug] : ['--all']), ...(input.force ? ['--force'] : []), '--json'], { timeout: 15 * 60_000, maxBuffer: 32 << 20 })
            const r = JSON.parse(stdout) as { scanned: number; snapshots: number; errors: number; chError: string | null; results: { slug: string; action: string; error?: string }[] }
            return { scanned: r.scanned, snapshots: r.snapshots, errors: r.errors, chError: r.chError, failed: r.results.filter((x) => x.error).map((x) => `${x.slug}: ${x.error}`) }
        } catch (e) {
            const err = e as { stderr?: string; message: string }
            throw new TRPCError({ code: 'BAD_REQUEST', message: (err.stderr || err.message).replace(/^nightly: /, '').trim() })
        }
    }),
})
