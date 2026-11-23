import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { can, canProject, folderTree, validGrant, wouldCycle, type ProjectScope } from '../../lib/permissions.mjs'
import { PROJECT_TYPES, checkSlug, parseSettings } from '../../lib/projects-core.mjs'
import { checked } from './accountsRouter'
import type { Viewer } from './auth'
import { db } from './db'
import { permProcedure, procedure, router } from './trpc'

// Folders (a tree) and projects. A user sees every project with projects.view, otherwise only the
// projects a ProjectAccess row gives them (on the project, or on a folder above it). Editing works
// the same way with projects.edit. Phase 2+ hangs project tabs (tasks, builds, perf ...) off
// /projects/[slug]/[[...tab]]; they read the project through project.get.
const bad = (message: string) => new TRPCError({ code: 'BAD_REQUEST', message })
const nope = () => new TRPCError({ code: 'FORBIDDEN', message: 'no access to this project' })

/** Everything canProject needs for one viewer, read in three queries. */
export async function projectScope(v: Viewer): Promise<ProjectScope> {
    const [access, folders, projects] = await Promise.all([
        db.projectAccess.findMany({ where: { OR: [{ userId: v.id }, { roleId: { in: v.roleIds } }] } }),
        db.folder.findMany({ select: { id: true, parentId: true } }),
        db.project.findMany({ select: { id: true, folderId: true } }),
    ])
    return {
        userId: v.id, roleIds: v.roleIds, access,
        parents: new Map(folders.map((f) => [f.id, f.parentId])),
        projectFolder: new Map(projects.map((p) => [p.id, p.folderId])),
    }
}

/** May the viewer do `key` on this project? Throws FORBIDDEN if not. */
export async function assertProject(v: Viewer | null, key: string, projectId: number) {
    if (!v) throw new TRPCError({ code: 'UNAUTHORIZED' })
    if (can(v.perms, key)) return
    if (!canProject(v.perms, await projectScope(v), key, projectId)) throw nope()
}

const projectShape = z.object({
    slug: z.string(),
    name: z.string().min(1).max(120),
    type: z.enum(PROJECT_TYPES as [string, ...string[]]),
    repoPath: z.string().max(500).default(''),
    repoUrl: z.string().max(500).refine((u) => !u || /^(https?:\/\/|git@|ssh:\/\/)/.test(u), 'repoUrl: http(s), ssh or git@ address').default(''),
    folderId: z.number().int().nullable().default(null),
    sort: z.number().int().default(0),
    settings: z.record(z.string(), z.unknown()).default({}),
    archived: z.boolean().default(false),
})

const folderRouter = router({
    tree: procedure.query(async ({ ctx }) => {
        const folders = await ctx.db.folder.findMany({ orderBy: [{ sort: 'asc' }, { name: 'asc' }] })
        return folderTree(folders)
    }),
    list: procedure.query(({ ctx }) => ctx.db.folder.findMany({ orderBy: [{ sort: 'asc' }, { name: 'asc' }] })),
    create: permProcedure('projects.create')
        .input(z.object({ name: z.string().min(1).max(80), parentId: z.number().int().nullable().default(null), sort: z.number().int().default(0) }))
        .mutation(async ({ ctx, input }) => {
            if (input.parentId != null && !(await ctx.db.folder.findUnique({ where: { id: input.parentId } }))) throw bad('no such parent folder')
            return ctx.db.folder.create({ data: { ...input, name: input.name.trim(), createdAt: new Date() } })
        }),
    edit: permProcedure('projects.edit')
        .input(z.object({ id: z.number().int(), name: z.string().min(1).max(80).optional(), parentId: z.number().int().nullable().optional(), sort: z.number().int().optional() }))
        .mutation(async ({ ctx, input }) => {
            const { id, ...data } = input
            if (data.parentId !== undefined) {
                const folders = await ctx.db.folder.findMany({ select: { id: true, parentId: true } })
                if (data.parentId != null && !folders.some((f) => f.id === data.parentId)) throw bad('no such parent folder')
                if (wouldCycle(id, data.parentId, new Map(folders.map((f) => [f.id, f.parentId])))) throw bad('a folder cannot move into itself')
            }
            return ctx.db.folder.update({ where: { id }, data: { ...data, ...(data.name ? { name: data.name.trim() } : {}) } })
        }),
    /** Children and projects move up to the deleted folder's parent. */
    delete: permProcedure('projects.delete')
        .input(z.object({ id: z.number().int() }))
        .mutation(async ({ ctx, input }) => {
            const f = await ctx.db.folder.findUnique({ where: { id: input.id } })
            if (!f) throw new TRPCError({ code: 'NOT_FOUND' })
            await ctx.db.$transaction([
                ctx.db.folder.updateMany({ where: { parentId: f.id }, data: { parentId: f.parentId } }),
                ctx.db.project.updateMany({ where: { folderId: f.id }, data: { folderId: f.parentId } }),
                ctx.db.folder.delete({ where: { id: f.id } }),
            ])
            return { ok: true }
        }),
})

const SORTS = { name: { name: 'asc' }, slug: { slug: 'asc' }, type: { type: 'asc' }, updated: { updatedAt: 'desc' }, created: { createdAt: 'desc' }, sort: { sort: 'asc' } } as const

const projectRouter = router({
    list: procedure
        .input(z.object({
            q: z.string().max(100).optional(),
            type: z.enum(PROJECT_TYPES as [string, ...string[]]).optional(),
            folderId: z.number().int().nullable().optional(),
            /** Include projects in subfolders of folderId. */
            deep: z.boolean().default(true),
            archived: z.boolean().default(false),
            sort: z.enum(Object.keys(SORTS) as [keyof typeof SORTS, ...(keyof typeof SORTS)[]]).default('sort'),
        }).default({ deep: true, archived: false, sort: 'sort' }))
        .query(async ({ ctx, input }) => {
            const v = ctx.viewer!
            let folderIds: number[] | undefined
            if (input.folderId != null && input.deep) {
                const folders = await ctx.db.folder.findMany({ select: { id: true, parentId: true } })
                const keep = new Set([input.folderId])
                for (let grew = true; grew;) {
                    grew = false
                    for (const f of folders) if (f.parentId != null && keep.has(f.parentId) && !keep.has(f.id)) { keep.add(f.id); grew = true }
                }
                folderIds = [...keep]
            }
            const rows = await ctx.db.project.findMany({
                where: {
                    ...(input.archived ? {} : { archived: false }),
                    ...(input.type ? { type: input.type } : {}),
                    ...(input.folderId === null ? { folderId: null } : folderIds ? { folderId: { in: folderIds } } : input.folderId != null ? { folderId: input.folderId } : {}),
                    ...(input.q ? { OR: [{ slug: { contains: input.q } }, { name: { contains: input.q } }] } : {}),
                },
                orderBy: [SORTS[input.sort], { name: 'asc' }],
                include: { folder: { select: { id: true, name: true } } },
            })
            const out = rows.map((p) => ({ ...p, settings: parseSettings(p.settings) }))
            if (can(v.perms, 'projects.view')) return out
            const scope = await projectScope(v)
            return out.filter((p) => canProject(v.perms, scope, 'projects.view', p.id))
        }),
    get: procedure.input(z.object({ slug: z.string() })).query(async ({ ctx, input }) => {
        const p = await ctx.db.project.findUnique({ where: { slug: input.slug }, include: { folder: true, builds: true } })
        if (!p) throw new TRPCError({ code: 'NOT_FOUND', message: `no project ${input.slug}` })
        await assertProject(ctx.viewer, 'projects.view', p.id)
        const v = ctx.viewer!
        const scope = can(v.perms, 'projects.edit') ? null : await projectScope(v)
        return { ...p, settings: parseSettings(p.settings), canEdit: !scope || canProject(v.perms, scope, 'projects.edit', p.id) }
    }),
    create: permProcedure('projects.create').input(projectShape).mutation(async ({ ctx, input }) => {
        const slug = checked(() => checkSlug(input.slug))
        if (await ctx.db.project.findUnique({ where: { slug } })) throw bad(`project ${slug} exists`)
        const now = new Date()
        return ctx.db.project.create({ data: { ...input, slug, settings: JSON.stringify(input.settings), createdAt: now, updatedAt: now } })
    }),
    edit: procedure
        .input(projectShape.partial().extend({ id: z.number().int() }))
        .mutation(async ({ ctx, input }) => {
            await assertProject(ctx.viewer, 'projects.edit', input.id)
            const { id, settings, slug, ...rest } = input
            const data: Record<string, unknown> = { ...rest, updatedAt: new Date() }
            if (slug !== undefined) {
                data.slug = checked(() => checkSlug(slug))
                const other = await ctx.db.project.findUnique({ where: { slug: data.slug as string } })
                if (other && other.id !== id) throw bad(`project ${data.slug} exists`)
            }
            if (settings !== undefined) data.settings = JSON.stringify(settings)
            return ctx.db.project.update({ where: { id }, data })
        }),
    delete: procedure.input(z.object({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
        await assertProject(ctx.viewer, 'projects.delete', input.id)
        await ctx.db.project.delete({ where: { id: input.id } })
        return { ok: true }
    }),
})

const accessInput = z.object({
    projectId: z.number().int().nullable().default(null),
    folderId: z.number().int().nullable().default(null),
    userId: z.number().int().nullable().default(null),
    roleId: z.number().int().nullable().default(null),
    perms: z.array(z.string()).min(1),
})

const accessRouter = router({
    list: permProcedure('admin.users').input(z.object({ projectId: z.number().int().optional(), folderId: z.number().int().optional() }).default({})).query(({ ctx, input }) =>
        ctx.db.projectAccess.findMany({
            where: { ...(input.projectId ? { projectId: input.projectId } : {}), ...(input.folderId ? { folderId: input.folderId } : {}) },
            include: { user: { select: { id: true, username: true } }, role: { select: { id: true, name: true } }, project: { select: { id: true, slug: true } }, folder: { select: { id: true, name: true } } },
            orderBy: { id: 'asc' },
        }),
    ),
    grant: permProcedure('admin.users').input(accessInput).mutation(({ ctx, input }) => {
        if ((input.projectId == null) === (input.folderId == null)) throw bad('give exactly one of projectId, folderId')
        if ((input.userId == null) === (input.roleId == null)) throw bad('give exactly one of userId, roleId')
        if (input.perms.some((p) => !validGrant(p))) throw bad('unknown permission')
        return ctx.db.projectAccess.create({ data: { ...input, perms: input.perms.join(','), createdAt: new Date() } })
    }),
    revoke: permProcedure('admin.users').input(z.object({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
        await ctx.db.projectAccess.delete({ where: { id: input.id } })
        return { ok: true }
    }),
})

export const projectRouters = { folder: folderRouter, project: projectRouter, access: accessRouter }
