import { TRPCError } from '@trpc/server'
import { can } from '../../lib/permissions.mjs'
import type { Viewer as Account } from './auth'

// Who is looking, and what they may do with transcripts. Built from the signed-in account (src/server/auth.ts):
// permissions come from the viewer's roles, `canSee` is own transcripts or everyone's with transcripts.viewAll.
// osUser is the login claude runs as: the viewer's NodeUser mapping on the local node when there is one, else the
// `transcriptsDefaultUser` setting (the human whose Claude subscription the panel uses), else the panel's own OS user.
export type Viewer = {
    userId: number
    username: string
    /** OS user on the local planet that claude runs as for this viewer. */
    osUser: string
    can: (perm: string) => boolean
    /** May this viewer read transcripts of `osUser`? (viewAll, or their own.) */
    canSee: (osUser: string) => boolean
}

type Ctx = { db: import('../../generated/prisma/client').PrismaClient; viewer: Account | null }

export async function getViewer(ctx: Ctx): Promise<Viewer> {
    const a = ctx.viewer
    if (!a) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'sign in first' })
    const row = await ctx.db.setting.findUnique({ where: { key: 'transcriptsDefaultUser' } }).catch(() => null)
    const mapped = await ctx.db.nodeUser.findFirst({ where: { userId: a.id, node: { type: { in: ['local', 'station'] } } }, orderBy: { nodeId: 'asc' } }).catch(() => null)
    const osUser = mapped?.username?.trim() || row?.value?.trim() || (await import('node:os')).userInfo().username
    const all = can(a.perms, 'transcripts.viewAll') || a.admin
    return {
        userId: a.id, username: a.username, osUser,
        can: (p) => can(a.perms, p),
        canSee: (u) => all || u === osUser,
    }
}

export function need(v: Viewer, perm: string) {
    if (!v.can(perm)) throw new TRPCError({ code: 'FORBIDDEN', message: `needs permission ${perm}` })
}
