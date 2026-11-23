import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { DEFAULT_ROLES, PERMISSIONS, validGrant } from '../../lib/permissions.mjs'
import { checkUsername, hashPassword, sha256, verifyPassword } from '../../lib/passwords.mjs'
import { endSession, endUserSessions, forgetViewers, type Viewer } from './auth'
import { db } from './db'
import { permProcedure, procedure, router } from './trpc'

// Accounts (own profile and sessions), users and roles. Admin-only parts use admin.users and
// admin.roles. Every change that can alter someone's permissions drops the viewer cache, and every
// password change or disable ends that user's other sessions.

/** Run a check from lib (it throws plain Errors) and turn its message into a 400. */
export function checked<T>(fn: () => T): T {
    try {
        return fn()
    } catch (e) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: (e as Error).message })
    }
}
const bad = (message: string) => new TRPCError({ code: 'BAD_REQUEST', message })
const me = (v: Viewer | null) => {
    if (!v) throw new TRPCError({ code: 'UNAUTHORIZED' })
    return v
}

const userSelect = {
    id: true, username: true, name: true, disabledAt: true, lastLoginAt: true, createdAt: true,
    roles: { select: { role: { select: { id: true, name: true } } } },
    grants: { select: { perm: true, allow: true } },
    _count: { select: { sessions: true } },
} as const

/** Enabled users holding the admin role (or a `*` grant through any role). */
type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0]
async function adminIds(tx: Tx) {
    const rows = await tx.user.findMany({
        where: { disabledAt: null, OR: [{ roles: { some: { role: { grants: { some: { perm: '*', allow: true } } } } } }, { grants: { some: { perm: '*', allow: true } } }] },
        select: { id: true },
    })
    return rows.map((r) => r.id)
}
/** Refuse a change that would leave the workspace without an enabled admin. */
async function keepAnAdmin(change: (tx: Tx) => Promise<unknown>) {
    return db.$transaction(async (tx) => {
        const r = await change(tx)
        if (!(await adminIds(tx)).length) throw bad('that would leave no enabled admin')
        return r
    })
}

const accountRouter = router({
    me: procedure.query(({ ctx }) => {
        const v = me(ctx.viewer)
        return { id: v.id, username: v.username, name: v.name, roles: v.roles, perms: v.perms, admin: v.admin }
    }),
    permissions: procedure.query(() => PERMISSIONS),
    edit: permProcedure('account.edit')
        .input(z.object({ name: z.string().max(80) }))
        .mutation(async ({ ctx, input }) => {
            await ctx.db.user.update({ where: { id: me(ctx.viewer).id }, data: { name: input.name.trim(), updatedAt: new Date() } })
            forgetViewers()
            return { ok: true }
        }),
    changePassword: permProcedure('account.edit')
        .input(z.object({ current: z.string(), next: z.string().max(200) }))
        .mutation(async ({ ctx, input }) => {
            const u = await ctx.db.user.findUniqueOrThrow({ where: { id: me(ctx.viewer).id } })
            if (!verifyPassword(input.current, u.hash)) throw bad('current password is wrong')
            const hash = checked(() => hashPassword(input.next))
            await ctx.db.user.update({ where: { id: u.id }, data: { hash, updatedAt: new Date() } })
            await endUserSessions(u.id, ctx.token)
            return { ok: true }
        }),
    sessions: procedure.query(async ({ ctx }) => {
        const rows = await ctx.db.session.findMany({ where: { userId: me(ctx.viewer).id }, orderBy: { lastSeenAt: 'desc' }, select: { id: true, tokenHash: true, createdAt: true, lastSeenAt: true, expiresAt: true, ip: true, userAgent: true } })
        const current = ctx.token ? sha256(ctx.token) : ''
        return rows.map(({ tokenHash, ...r }) => ({ ...r, current: tokenHash === current }))
    }),
    logoutOthers: procedure.mutation(async ({ ctx }) => {
        await endUserSessions(me(ctx.viewer).id, ctx.token)
        return { ok: true }
    }),
    logout: procedure.mutation(async ({ ctx }) => {
        await endSession(ctx.token)
        return { ok: true }
    }),
})

const userInput = z.object({
    username: z.string(),
    name: z.string().max(80).default(''),
    password: z.string().max(200),
    roles: z.array(z.string()).default(['user']),
})

const userRouter = router({
    list: permProcedure('admin.users').query(({ ctx }) => ctx.db.user.findMany({ select: userSelect, orderBy: { username: 'asc' } })),
    create: permProcedure('admin.users')
        .input(userInput)
        .mutation(async ({ ctx, input }) => {
            const username = checked(() => checkUsername(input.username))
            const hash = checked(() => hashPassword(input.password))
            if (await ctx.db.user.findUnique({ where: { username } })) throw bad(`user ${username} exists`)
            const roles = await ctx.db.role.findMany({ where: { name: { in: input.roles } } })
            if (roles.length !== new Set(input.roles).size) throw bad('unknown role')
            const now = new Date()
            return ctx.db.user.create({ data: { username, name: input.name.trim(), hash, createdAt: now, updatedAt: now, roles: { create: roles.map((r) => ({ roleId: r.id })) } }, select: userSelect })
        }),
    edit: permProcedure('admin.users')
        .input(z.object({
            id: z.number().int(),
            name: z.string().max(80).optional(),
            password: z.string().max(200).optional(),
            disabled: z.boolean().optional(),
            roles: z.array(z.string()).optional(),
            grants: z.array(z.object({ perm: z.string(), allow: z.boolean() })).optional(),
        }))
        .mutation(async ({ ctx, input }) => {
            const u = await ctx.db.user.findUnique({ where: { id: input.id } })
            if (!u) throw new TRPCError({ code: 'NOT_FOUND' })
            const hash = input.password ? checked(() => hashPassword(input.password!)) : undefined
            if (input.grants?.some((g) => !validGrant(g.perm))) throw bad('unknown permission in grants')
            const roles = input.roles && (await ctx.db.role.findMany({ where: { name: { in: input.roles } } }))
            if (input.roles && roles && roles.length !== new Set(input.roles).size) throw bad('unknown role')
            await keepAnAdmin(async (tx) => {
                await tx.user.update({
                    where: { id: u.id },
                    data: {
                        updatedAt: new Date(),
                        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
                        ...(hash ? { hash } : {}),
                        ...(input.disabled !== undefined ? { disabledAt: input.disabled ? (u.disabledAt ?? new Date()) : null } : {}),
                    },
                })
                if (roles) {
                    await tx.userRole.deleteMany({ where: { userId: u.id } })
                    for (const r of roles) await tx.userRole.create({ data: { userId: u.id, roleId: r.id } })
                }
                if (input.grants) {
                    await tx.permissionGrant.deleteMany({ where: { userId: u.id } })
                    for (const g of input.grants) await tx.permissionGrant.create({ data: { userId: u.id, perm: g.perm, allow: g.allow } })
                }
            })
            // A new password or a disable signs the user out everywhere (the admin keeps their own session).
            if (hash || input.disabled) await endUserSessions(u.id, u.id === ctx.viewer?.id ? ctx.token : '')
            forgetViewers()
            return ctx.db.user.findUniqueOrThrow({ where: { id: u.id }, select: userSelect })
        }),
    delete: permProcedure('admin.users')
        .input(z.object({ id: z.number().int() }))
        .mutation(async ({ ctx, input }) => {
            if (input.id === ctx.viewer?.id) throw bad('you cannot delete yourself')
            await keepAnAdmin((tx) => tx.user.delete({ where: { id: input.id } }))
            forgetViewers()
            return { ok: true }
        }),
})

const ROLE_NAME = /^[a-z0-9][a-z0-9._-]{1,31}$/
const roleRouter = router({
    list: permProcedure('admin.roles').query(({ ctx }) =>
        ctx.db.role.findMany({ orderBy: { name: 'asc' }, include: { grants: { select: { perm: true } }, _count: { select: { users: true } } } }),
    ),
    defaults: permProcedure('admin.roles').query(() => DEFAULT_ROLES),
    create: permProcedure('admin.roles')
        .input(z.object({ name: z.string(), description: z.string().max(200).default(''), grants: z.array(z.string()).default([]) }))
        .mutation(async ({ ctx, input }) => {
            const name = input.name.trim().toLowerCase()
            if (!ROLE_NAME.test(name)) throw bad('role name: 2-32 of a-z 0-9 . _ -')
            if (input.grants.some((g) => !validGrant(g))) throw bad('unknown permission in grants')
            if (await ctx.db.role.findUnique({ where: { name } })) throw bad(`role ${name} exists`)
            return ctx.db.role.create({ data: { name, description: input.description, createdAt: new Date(), grants: { create: [...new Set(input.grants)].map((perm) => ({ perm, allow: true })) } } })
        }),
    edit: permProcedure('admin.roles')
        .input(z.object({ id: z.number().int(), description: z.string().max(200).optional(), grants: z.array(z.string()).optional() }))
        .mutation(async ({ ctx, input }) => {
            const r = await ctx.db.role.findUnique({ where: { id: input.id } })
            if (!r) throw new TRPCError({ code: 'NOT_FOUND' })
            if (input.grants?.some((g) => !validGrant(g))) throw bad('unknown permission in grants')
            if (r.name === 'admin' && input.grants && !input.grants.includes('*')) throw bad('the admin role keeps *')
            await keepAnAdmin(async (tx) => {
                if (input.description !== undefined) await tx.role.update({ where: { id: r.id }, data: { description: input.description } })
                if (input.grants) {
                    await tx.permissionGrant.deleteMany({ where: { roleId: r.id } })
                    for (const perm of new Set(input.grants)) await tx.permissionGrant.create({ data: { roleId: r.id, perm, allow: true } })
                }
            })
            forgetViewers()
            return { ok: true }
        }),
    delete: permProcedure('admin.roles')
        .input(z.object({ id: z.number().int() }))
        .mutation(async ({ ctx, input }) => {
            const r = await ctx.db.role.findUnique({ where: { id: input.id } })
            if (!r) throw new TRPCError({ code: 'NOT_FOUND' })
            if (r.builtin) throw bad(`${r.name} is a builtin role`)
            await keepAnAdmin((tx) => tx.role.delete({ where: { id: r.id } }))
            forgetViewers()
            return { ok: true }
        }),
})

export const accountRouters = { account: accountRouter, user: userRouter, role: roleRouter }
