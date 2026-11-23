import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { newToken, sha256 } from '../../lib/passwords.mjs'
import { DB_KINDS, LINK_AUTH, NODE_TYPES, OFFLOAD_KINDS, checkSpecs } from '../../lib/node-specs.mjs'
import { checked } from './accountsRouter'
import { permProcedure, router } from './trpc'

// The node registry (phase 1: records only; the node daemon that dials in with its token lands in
// a later phase). A node's token is shown once at creation or rotation and stored as sha256; its
// shared secret is never returned. Database connections hold a secretRef (an env var or file name),
// never a password. Hosts live only in this database, never in the repository.
const bad = (message: string) => new TRPCError({ code: 'BAD_REQUEST', message })
const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/
const name = z.string().trim().toLowerCase().regex(NAME, 'name: a-z 0-9 . _ -')
const nodeSelect = { id: true, name: true, type: true, host: true, port: true, tls: true, specs: true, status: true, notes: true, lastSeenAt: true, createdAt: true, updatedAt: true } as const
const withSpecs = <T extends { specs: string }>(n: T) => ({ ...n, specs: checkSpecs(n.specs) })

const nodeShape = z.object({
    name,
    type: z.enum(NODE_TYPES as [string, ...string[]]).default('station'),
    host: z.string().max(255).default(''),
    port: z.number().int().min(1).max(65535).default(4001),
    tls: z.boolean().default(false),
    specs: z.record(z.string(), z.unknown()).default({}),
    notes: z.string().max(2000).default(''),
})

const nodeRouter = router({
    list: permProcedure('nodes.view').query(async ({ ctx }) => (await ctx.db.node.findMany({ select: nodeSelect, orderBy: [{ type: 'asc' }, { name: 'asc' }] })).map(withSpecs)),
    get: permProcedure('nodes.view').input(z.object({ id: z.number().int() })).query(async ({ ctx, input }) => {
        const n = await ctx.db.node.findUnique({ where: { id: input.id }, select: { ...nodeSelect, users: { include: { user: { select: { username: true } } } } } })
        if (!n) throw new TRPCError({ code: 'NOT_FOUND' })
        return withSpecs(n)
    }),
    offloadKinds: permProcedure('nodes.view').query(() => OFFLOAD_KINDS),
    /** Returns the node token once. */
    create: permProcedure('admin.nodes').input(nodeShape).mutation(async ({ ctx, input }) => {
        if (await ctx.db.node.findUnique({ where: { name: input.name } })) throw bad(`node ${input.name} exists`)
        if (input.type === 'planet' && (await ctx.db.node.findFirst({ where: { type: 'planet' } }))) throw bad('there is already a planet')
        const specs = JSON.stringify(checked(() => checkSpecs(input.specs)))
        const token = `nn_${newToken(24)}`
        const now = new Date()
        const n = await ctx.db.node.create({ data: { ...input, specs, tokenHash: sha256(token), secret: newToken(32), createdAt: now, updatedAt: now }, select: nodeSelect })
        return { node: withSpecs(n), token }
    }),
    edit: permProcedure('admin.nodes').input(nodeShape.partial().extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
        const { id, specs, ...rest } = input
        if (rest.type === 'planet' && (await ctx.db.node.findFirst({ where: { type: 'planet', NOT: { id } } }))) throw bad('there is already a planet')
        const data = { ...rest, updatedAt: new Date(), ...(specs ? { specs: JSON.stringify(checked(() => checkSpecs(specs))) } : {}) }
        return withSpecs(await ctx.db.node.update({ where: { id }, data, select: nodeSelect }))
    }),
    rotateToken: permProcedure('admin.nodes').input(z.object({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
        const token = `nn_${newToken(24)}`
        await ctx.db.node.update({ where: { id: input.id }, data: { tokenHash: sha256(token), updatedAt: new Date() } })
        return { token }
    }),
    delete: permProcedure('admin.nodes').input(z.object({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
        await ctx.db.node.delete({ where: { id: input.id } })
        return { ok: true }
    }),
})

const nodeUserRouter = router({
    list: permProcedure('nodes.view').input(z.object({ nodeId: z.number().int().optional() }).default({})).query(({ ctx, input }) =>
        ctx.db.nodeUser.findMany({ where: input.nodeId ? { nodeId: input.nodeId } : {}, include: { node: { select: { name: true } }, user: { select: { username: true } } }, orderBy: { id: 'asc' } }),
    ),
    set: permProcedure('admin.nodes')
        .input(z.object({ nodeId: z.number().int(), userId: z.number().int(), username: z.string().trim().regex(/^[a-z_][a-z0-9_-]{0,31}$/, 'os user: a-z 0-9 _ -') }))
        .mutation(({ ctx, input }) => ctx.db.nodeUser.upsert({ where: { nodeId_userId: { nodeId: input.nodeId, userId: input.userId } }, create: input, update: { username: input.username } })),
    delete: permProcedure('admin.nodes').input(z.object({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
        await ctx.db.nodeUser.delete({ where: { id: input.id } })
        return { ok: true }
    }),
})

const nodeLinkRouter = router({
    list: permProcedure('nodes.view').query(({ ctx }) =>
        ctx.db.nodeLink.findMany({ include: { from: { select: { name: true } }, to: { select: { name: true } } }, orderBy: { id: 'asc' } }),
    ),
    create: permProcedure('admin.nodes')
        .input(z.object({ fromId: z.number().int(), toId: z.number().int(), username: z.string().trim().max(32).default(''), auth: z.enum(LINK_AUTH as [string, ...string[]]).default('ssh-key') }))
        .mutation(({ ctx, input }) => {
            if (input.fromId === input.toId) throw bad('a node cannot link to itself')
            return ctx.db.nodeLink.create({ data: { ...input, createdAt: new Date() } })
        }),
    delete: permProcedure('admin.nodes').input(z.object({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
        await ctx.db.nodeLink.delete({ where: { id: input.id } })
        return { ok: true }
    }),
})

const dbShape = z.object({
    name,
    kind: z.enum(DB_KINDS as [string, ...string[]]).default('clickhouse'),
    host: z.string().max(255).default(''),
    port: z.number().int().min(0).max(65535).default(0),
    database: z.string().max(120).default(''),
    username: z.string().max(120).default(''),
    /** The NAME of an env var or file holding the password; never the password. */
    secretRef: z.string().max(200).regex(/^[A-Za-z0-9_./-]*$/, 'secretRef: an env var or file name, not a secret').default(''),
    options: z.record(z.string(), z.unknown()).default({}),
})

const dbConnectionRouter = router({
    list: permProcedure('admin.databases').query(({ ctx }) => ctx.db.dbConnection.findMany({ orderBy: { name: 'asc' } })),
    create: permProcedure('admin.databases').input(dbShape).mutation(async ({ ctx, input }) => {
        if (await ctx.db.dbConnection.findUnique({ where: { name: input.name } })) throw bad(`connection ${input.name} exists`)
        const now = new Date()
        return ctx.db.dbConnection.create({ data: { ...input, options: JSON.stringify(input.options), createdAt: now, updatedAt: now } })
    }),
    edit: permProcedure('admin.databases').input(dbShape.partial().extend({ id: z.number().int() })).mutation(({ ctx, input }) => {
        const { id, options, ...rest } = input
        return ctx.db.dbConnection.update({ where: { id }, data: { ...rest, updatedAt: new Date(), ...(options ? { options: JSON.stringify(options) } : {}) } })
    }),
    delete: permProcedure('admin.databases').input(z.object({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
        await ctx.db.dbConnection.delete({ where: { id: input.id } })
        return { ok: true }
    }),
})

const buildShape = z.object({
    projectId: z.number().int(),
    name: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/, 'name: a-z 0-9 . _ -'),
    command: z.string().max(2000).default(''),
    heavy: z.boolean().default(false),
    nodeKinds: z.array(z.enum(OFFLOAD_KINDS as [string, ...string[]])).default([]),
    /** Seconds; 0 = unlimited. */
    timeout: z.number().int().min(0).default(0),
    enabled: z.boolean().default(true),
})

const buildConfigRouter = router({
    list: permProcedure('admin.builds').input(z.object({ projectId: z.number().int().optional() }).default({})).query(({ ctx, input }) =>
        ctx.db.buildConfig.findMany({ where: input.projectId ? { projectId: input.projectId } : {}, include: { project: { select: { slug: true } } }, orderBy: [{ projectId: 'asc' }, { name: 'asc' }] }),
    ),
    set: permProcedure('admin.builds').input(buildShape).mutation(({ ctx, input }) => {
        const data = { ...input, nodeKinds: input.nodeKinds.join(','), updatedAt: new Date() }
        return ctx.db.buildConfig.upsert({ where: { projectId_name: { projectId: input.projectId, name: input.name } }, create: { ...data, createdAt: new Date() }, update: data })
    }),
    delete: permProcedure('admin.builds').input(z.object({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
        await ctx.db.buildConfig.delete({ where: { id: input.id } })
        return { ok: true }
    }),
})

export const nodeRouters = { node: nodeRouter, nodeUser: nodeUserRouter, nodeLink: nodeLinkRouter, dbConnection: dbConnectionRouter, buildConfig: buildConfigRouter }
