// Nodes, links, databases, builds and offload jobs for the admin pages. The panel talks to node daemons through
// nodeManager; none of this loads node:sqlite (the CLI-side registry is lib/nodes.mjs).
import { createHash, randomBytes } from 'node:crypto'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { DB_KINDS, LINK_AUTH, NODE_TYPES, OFFLOAD_KINDS, checkSpecs as check, type NodeSpecs } from '../../lib/node-specs.mjs'
import { detectCompose } from '../../lib/db-detect.mjs'
import { detectHeavy, inferKinds, pickNode } from '../../lib/node-sched.mjs'
import { cancelJob, dispatchQueued, enqueueJob, nodeMgr, syncNodes } from './nodeManager'
import { db as prisma } from './db'
import { permProcedure, router } from './trpc'

const adminProc = permProcedure('admin.nodes')
const checkSpecs = (s: unknown) => check(s as NodeSpecs)
const json = <T,>(s: string | null | undefined, d: T): T => { try { return s ? (JSON.parse(s) as T) : d } catch { return d } }
const NAME = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/i, 'letters, digits, . _ - (max 63)')
const OSUSER = z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/, 'lowercase letters, digits, _ or -')
const newToken = () => `nn_${randomBytes(24).toString('base64url')}`
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const fail = (e: unknown): never => { throw new TRPCError({ code: 'BAD_REQUEST', message: (e as Error).message }) }
const TYPE = z.enum(NODE_TYPES as ['planet', 'station'])
const KIND = z.enum(OFFLOAD_KINDS as [string, ...string[]])
const specsIn = z.object({
    cpu: z.object({ model: z.string(), mhz: z.number(), cores: z.number(), threads: z.number() }).partial().optional(),
    ram: z.object({ gb: z.number(), type: z.string(), mhz: z.number() }).partial().optional(),
    gpu: z.array(z.string()).optional(),
    buildSlots: z.number().int().min(0).max(256).optional(),
    heavySlots: z.number().int().min(0).max(256).optional(),
    offloadKinds: z.array(KIND).optional(),
}).passthrough()

async function node(id: number) {
    const n = await prisma.node.findUnique({ where: { id } })
    if (!n) throw new TRPCError({ code: 'NOT_FOUND', message: 'no such node' })
    return n
}
const live = (id: number) => nodeMgr().statuses().find((s) => s.id === id)
const call = async (id: number, op: string, args?: unknown) => {
    try { return await nodeMgr().request(id, op, args) } catch (e) { return fail(e) }
}
const saveLink = (fromId: number, toId: number, username: string, auth: string, ok: boolean) => {
    const data = { auth, status: ok ? 'ok' : 'failed', checkedAt: new Date() }
    return prisma.nodeLink.upsert({ where: { fromId_toId_username: { fromId, toId, username } }, create: { fromId, toId, username, ...data }, update: data })
}

export const nodeOpsRouter = router({
    meta: adminProc.query(() => ({ types: NODE_TYPES, kinds: OFFLOAD_KINDS, linkAuth: LINK_AUTH, dbKinds: DB_KINDS })),

    list: adminProc.query(async ({ ctx }) => {
        const rows = await ctx.db.node.findMany({ include: { users: { include: { user: { select: { username: true } } } } }, orderBy: [{ type: 'desc' }, { name: 'asc' }] })
        return rows.map(({ secret: _s, tokenHash, specs, conn, users, ...n }) => {
            const s = live(n.id)
            return { ...n, hasToken: !!tokenHash, specs: json<Record<string, any>>(specs, {}), conn: json<Record<string, unknown>>(conn, {}), state: s?.state ?? 'offline', error: s?.error ?? '', slots: (s?.live?.slots ?? null) as { build?: { used: number; max: number }; heavy?: { used: number; max: number } } | null, version: s?.version ?? '', users: users.map((u) => ({ id: u.id, userId: u.userId, user: u.user.username, osUser: u.username })) }
        })
    }),

    create: adminProc.input(z.object({ name: NAME, type: TYPE.default('station'), host: z.string().max(253).default(''), port: z.number().int().min(1).max(65535).default(4001), tls: z.boolean().default(false), specs: specsIn.default({}), notes: z.string().max(2000).default(''), token: z.string().min(16).max(200).optional() }))
        .mutation(async ({ ctx, input }) => {
            if (await ctx.db.node.findUnique({ where: { name: input.name } })) fail(new Error(`node "${input.name}" exists`))
            const token = input.token ?? newToken()
            const n = await ctx.db.node.create({ data: { name: input.name, type: input.type, host: input.host, port: input.port, tls: input.tls, tokenHash: sha(token), secret: token, specs: JSON.stringify(checkSpecs(input.specs)), notes: input.notes } })
            await syncNodes()
            return { id: n.id, token }
        }),

    update: adminProc.input(z.object({ id: z.number().int(), name: NAME.optional(), type: TYPE.optional(), host: z.string().max(253).optional(), port: z.number().int().min(1).max(65535).optional(), tls: z.boolean().optional(), specs: specsIn.optional(), notes: z.string().max(2000).optional(), conn: z.object({ fingerprint: z.string().optional(), tlsVerify: z.boolean().optional() }).optional() }))
        .mutation(async ({ ctx, input }) => {
            const { id, specs, conn, ...rest } = input
            await node(id)
            try { await ctx.db.node.update({ where: { id }, data: { ...rest, ...(specs ? { specs: JSON.stringify(checkSpecs(specs)) } : {}), ...(conn ? { conn: JSON.stringify(conn) } : {}) } }) } catch (e) { fail(e) }
            if (specs && live(id)?.state === 'online' && (specs.offloadKinds || specs.buildSlots != null || specs.heavySlots != null)) {
                await nodeMgr().request(id, 'config.set', { kinds: specs.offloadKinds, buildSlots: specs.buildSlots, heavySlots: specs.heavySlots }).catch(() => {})
            }
            await syncNodes()
            void dispatchQueued()
            return { ok: true }
        }),

    remove: adminProc.input(z.object({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
        await ctx.db.node.delete({ where: { id: input.id } }).catch(() => fail(new Error('no such node')))
        await syncNodes()
        return { ok: true }
    }),

    rotateToken: adminProc.input(z.object({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
        await node(input.id)
        const token = newToken()
        await ctx.db.node.update({ where: { id: input.id }, data: { tokenHash: sha(token), secret: token } })
        await syncNodes()
        return { token }
    }),

    /** Ask the daemon for its hardware and store it (operator-set slots and kinds are kept). */
    detect: adminProc.input(z.object({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
        const n = await node(input.id)
        const fresh = (await call(n.id, 'specs')) as Record<string, any>
        const old = json<Record<string, any>>(n.specs, {})
        const specs = { ...fresh, ...Object.fromEntries(['buildSlots', 'heavySlots', 'offloadKinds'].filter((k) => old[k] !== undefined).map((k) => [k, old[k]])) }
        await ctx.db.node.update({ where: { id: n.id }, data: { specs: JSON.stringify(specs) } })
        return specs
    }),

    users: router({
        panelUsers: adminProc.query(({ ctx }) => ctx.db.user.findMany({ select: { id: true, username: true }, orderBy: { username: 'asc' } })),
        assign: adminProc.input(z.object({ nodeId: z.number().int(), userId: z.number().int(), osUser: OSUSER })).mutation(async ({ ctx, input }) => {
            await ctx.db.nodeUser.upsert({ where: { nodeId_userId: { nodeId: input.nodeId, userId: input.userId } }, create: { nodeId: input.nodeId, userId: input.userId, username: input.osUser }, update: { username: input.osUser } })
            return { ok: true }
        }),
        unassign: adminProc.input(z.object({ nodeId: z.number().int(), userId: z.number().int() })).mutation(async ({ ctx, input }) => {
            await ctx.db.nodeUser.deleteMany({ where: input })
            return { ok: true }
        }),
        /** Create the OS user on the node (key and/or password), through the daemon. Needs the node's allowUserCreate. */
        createOnNode: adminProc.input(z.object({ nodeId: z.number().int(), username: OSUSER, password: z.string().min(8).max(200).optional(), publicKey: z.string().max(2000).optional(), generateKey: z.boolean().default(true), assignTo: z.number().int().optional() }))
            .mutation(async ({ ctx, input }) => {
                const { nodeId, assignTo, ...a } = input
                const r = await call(nodeId, 'user.create', a)
                if (assignTo) await ctx.db.nodeUser.upsert({ where: { nodeId_userId: { nodeId, userId: assignTo } }, create: { nodeId, userId: assignTo, username: input.username }, update: { username: input.username } })
                return r as { created?: boolean; publicKey?: string }
            }),
    }),

    links: router({
        graph: adminProc.query(async ({ ctx }) => {
            const [nodes, links] = await Promise.all([ctx.db.node.findMany({ orderBy: { name: 'asc' } }), ctx.db.nodeLink.findMany()])
            return {
                nodes: nodes.map((n) => ({ id: n.id, name: n.name, type: n.type, state: live(n.id)?.state ?? 'offline', host: n.host })),
                links: links.map((l) => ({ id: l.id, fromId: l.fromId, toId: l.toId, username: l.username, auth: l.auth, status: l.status, checkedAt: l.checkedAt })),
            }
        }),
        /** Connect: the from-node ssh's to the to-node as username (key, or password via sshpass); the result is recorded. */
        connect: adminProc.input(z.object({ fromId: z.number().int(), toId: z.number().int(), username: OSUSER, auth: z.enum(LINK_AUTH as ['ssh-key', 'password']).default('ssh-key'), password: z.string().max(200).optional(), sshPort: z.number().int().min(1).max(65535).default(22) }))
            .mutation(async ({ input }) => {
                if (input.fromId === input.toId) fail(new Error('a node cannot link to itself'))
                const to = await node(input.toId)
                await node(input.fromId)
                const r = (await call(input.fromId, 'ssh.check', { host: to.host, port: input.sshPort, username: input.username, password: input.auth === 'password' ? input.password : undefined })) as { ok: boolean; message: string }
                await saveLink(input.fromId, input.toId, input.username, input.auth, r.ok)
                return r
            }),
        /** Auto-connect: make a key on the from-node, create the user on the to-node when missing, authorize the key, verify. */
        auto: adminProc.input(z.object({ fromId: z.number().int(), toId: z.number().int(), username: OSUSER, sshPort: z.number().int().min(1).max(65535).default(22) }))
            .mutation(async ({ input }) => {
                if (input.fromId === input.toId) fail(new Error('a node cannot link to itself'))
                const steps: string[] = []
                const to = await node(input.toId)
                await node(input.fromId)
                const key = (await call(input.fromId, 'ssh.keygen', { username: input.username })) as { publicKey: string }
                steps.push(`key ready for ${input.username} on the source node`)
                const made = (await call(input.toId, 'user.create', { username: input.username, publicKey: key.publicKey })) as { created?: boolean }
                steps.push(made.created ? `created ${input.username} on ${to.name} and authorized the key` : `authorized the key for existing ${input.username} on ${to.name}`)
                const r = (await call(input.fromId, 'ssh.check', { host: to.host, port: input.sshPort, username: input.username })) as { ok: boolean; message: string }
                steps.push(r.ok ? 'ssh check passed' : `ssh check failed: ${r.message}`)
                await saveLink(input.fromId, input.toId, input.username, 'ssh-key', r.ok)
                return { ok: r.ok, steps }
            }),
        remove: adminProc.input(z.object({ id: z.number().int() })).mutation(async ({ ctx, input }) => { await ctx.db.nodeLink.delete({ where: { id: input.id } }).catch(() => fail(new Error('no such link'))); return { ok: true } }),
    }),

    databases: router({
        list: adminProc.query(({ ctx }) => ctx.db.dbConnection.findMany({ orderBy: { name: 'asc' } })),
        save: adminProc.input(z.object({ id: z.number().int().optional(), name: NAME, kind: z.enum(DB_KINDS as [string, ...string[]]), host: z.string().max(253).default(''), port: z.number().int().min(0).max(65535).default(0), database: z.string().max(120).default(''), username: z.string().max(120).default(''), secretRef: z.string().max(300).regex(/^[A-Za-z_/][A-Za-z0-9_.:/-]*$|^$/, 'an env var or file:VAR name, never the password').default('') }))
            .mutation(async ({ ctx, input }) => {
                const { id, ...d } = input
                return id ? ctx.db.dbConnection.update({ where: { id }, data: d }) : ctx.db.dbConnection.create({ data: d })
            }),
        remove: adminProc.input(z.object({ id: z.number().int() })).mutation(async ({ ctx, input }) => { await ctx.db.dbConnection.delete({ where: { id: input.id } }).catch(() => fail(new Error('no such connection'))); return { ok: true } }),
        /** Look for Docker Compose files with database services in the panel dir and every project repo; add the missing connections. */
        detect: adminProc.mutation(async ({ ctx }) => {
            const dirs = new Set<string>([process.cwd()])
            for (const p of await ctx.db.project.findMany({ select: { repoPath: true } })) if (p.repoPath) dirs.add(p.repoPath)
            const created: string[] = [], existing: string[] = []
            for (const dir of dirs) for (const c of detectCompose(dir)) {
                if (await ctx.db.dbConnection.findUnique({ where: { name: c.name } })) { existing.push(c.name); continue }
                const { file, ...row } = c
                await ctx.db.dbConnection.create({ data: { ...row, options: JSON.stringify({ source: 'compose', file }) } })
                created.push(c.name)
            }
            return { created, existing }
        }),
    }),

    builds: router({
        list: adminProc.query(async ({ ctx }) => {
            const [rows, projects] = await Promise.all([ctx.db.buildConfig.findMany({ include: { project: { select: { slug: true, name: true } } }, orderBy: [{ projectId: 'asc' }, { name: 'asc' }] }), ctx.db.project.findMany({ select: { id: true, slug: true, name: true }, orderBy: { slug: 'asc' } })])
            const last = await ctx.db.nodeJob.findMany({ where: { buildId: { not: null } }, orderBy: { id: 'desc' }, take: 300 })
            return { projects, builds: rows.map((b) => ({ ...b, heavyAuto: detectHeavy(b.command, false).heavy, last: last.find((j) => j.buildId === b.id) ?? null })) }
        }),
        save: adminProc.input(z.object({ id: z.number().int().optional(), projectId: z.number().int(), name: NAME, command: z.string().min(1).max(2000), heavy: z.boolean().default(false), nodeKinds: z.string().max(200).default('build'), timeout: z.number().int().min(0).default(0), enabled: z.boolean().default(true) }))
            .mutation(async ({ ctx, input }) => {
                const kinds = input.nodeKinds.split(',').map((s) => s.trim()).filter(Boolean)
                if (kinds.some((k) => !OFFLOAD_KINDS.includes(k))) fail(new Error(`kinds: ${OFFLOAD_KINDS.join(', ')}`))
                const { id, ...d } = input
                return id ? ctx.db.buildConfig.update({ where: { id }, data: d }) : ctx.db.buildConfig.upsert({ where: { projectId_name: { projectId: d.projectId, name: d.name } }, create: d, update: d })
            }),
        remove: adminProc.input(z.object({ id: z.number().int() })).mutation(async ({ ctx, input }) => { await ctx.db.buildConfig.delete({ where: { id: input.id } }).catch(() => fail(new Error('no such build'))); return { ok: true } }),
        /** A command's offload kinds and heavy-ness, shown in the form before saving. */
        detect: adminProc.input(z.object({ command: z.string().max(2000) })).query(({ input }) => ({ kinds: inferKinds(input.command), ...detectHeavy(input.command, false) })),
        run: adminProc.input(z.object({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
            const b = await ctx.db.buildConfig.findUnique({ where: { id: input.id } })
            if (!b) return fail(new Error('no such build'))
            const j = await enqueueJob({ name: b.name, command: b.command, kinds: b.nodeKinds.split(',').filter(Boolean), heavy: b.heavy, projectId: b.projectId, buildId: b.id })
            return { id: j.id }
        }),
    }),

    jobs: router({
        list: adminProc.input(z.object({ take: z.number().int().min(1).max(200).default(50) }).default({ take: 50 })).query(async ({ ctx, input }) => {
            const [jobs, nodes] = await Promise.all([ctx.db.nodeJob.findMany({ orderBy: { id: 'desc' }, take: input.take }), ctx.db.node.findMany({ select: { id: true, name: true } })])
            const name = new Map(nodes.map((n) => [n.id, n.name]))
            return jobs.map((j) => ({ ...j, node: j.nodeId ? name.get(j.nodeId) ?? null : null }))
        }),
        enqueue: adminProc.input(z.object({ name: z.string().max(120).default('adhoc'), command: z.string().min(1).max(2000), kind: KIND.optional(), heavy: z.boolean().optional() })).mutation(async ({ input }) => ({ id: (await enqueueJob(input)).id })),
        cancel: adminProc.input(z.object({ id: z.number().int() })).mutation(async ({ input }) => { await cancelJob(input.id); return { ok: true } }),
        /** Which node would take this right now, and why not. */
        plan: adminProc.input(z.object({ command: z.string(), kind: z.string().optional(), heavy: z.boolean().optional() })).query(async ({ ctx, input }) => {
            const rows = await ctx.db.node.findMany()
            const nodes = rows.map((n) => ({ id: n.id, name: n.name, type: n.type, online: live(n.id)?.state === 'online', specs: json(n.specs, {}), live: live(n.id)?.live ?? null }))
            const r = pickNode(nodes, { kinds: [input.kind ?? inferKinds(input.command)[0] ?? 'build'], heavy: detectHeavy(input.command, input.heavy).heavy })
            return { node: r.node?.name ?? null, why: r.why, capable: r.capable.map((n) => n.name) }
        }),
    }),
})
