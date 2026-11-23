import { initTRPC, TRPCError } from '@trpc/server'
import superjson from 'superjson'
import { ZodError } from 'zod'
import { can, procedurePerm } from '../../lib/permissions.mjs'
import { cookieFrom, viewerFromRequest, type Viewer } from './auth'
import { db } from './db'

/** Per request: the database, the signed-in viewer (null if none) and the raw session token (for "sign out other sessions"). */
export const createContext = async (opts?: { req?: Request }) => ({
    db,
    viewer: opts?.req ? await viewerFromRequest(opts.req) : (null as Viewer | null),
    token: opts?.req ? cookieFrom(opts.req.headers.get('cookie')) : '',
})
export type Context = Awaited<ReturnType<typeof createContext>>

const t = initTRPC.context<Context>().create({
    transformer: superjson,
    errorFormatter: ({ shape, error }) => ({
        ...shape,
        data: { ...shape.data, zodError: error.cause instanceof ZodError ? error.cause.flatten() : null },
    }),
})

const forbidden = (key: string) => new TRPCError({ code: 'FORBIDDEN', message: `missing permission ${key}` })

/** Every procedure needs a signed-in viewer, plus the router's permission from ROUTER_PERMS (lib/permissions.mjs). */
const guard = t.middleware(({ ctx, path, type, next }) => {
    if (!ctx.viewer) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'sign in first' })
    const need = procedurePerm(path, type)
    if (need && !can(ctx.viewer.perms, need)) throw forbidden(need)
    return next({ ctx: { ...ctx, viewer: ctx.viewer } })
})

/** Extension point: stack on any procedure to require more permissions (all of them). */
export const requirePerm = (...keys: string[]) => t.middleware(({ ctx, next }) => {
    for (const k of keys) if (!can(ctx.viewer?.perms, k)) throw forbidden(k)
    return next()
})

export const router = t.router
/** Signed in (and the router-level permission, if its router is in ROUTER_PERMS). */
export const procedure = t.procedure.use(guard)
/** Signed in and holding every one of `keys`. */
export const permProcedure = (...keys: string[]) => procedure.use(requirePerm(...keys))
