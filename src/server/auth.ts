import { db } from './db'
import { can, isAdmin, resolvePerms, type Perms } from '../../lib/permissions.mjs'
import { newToken, sha256, verifyPassword } from '../../lib/passwords.mjs'

// Accounts and sessions. Every visitor signs in with a username and password (User, scrypt hash).
// The session cookie holds a random token; only its sha256 is stored (Session.tokenHash), so a
// copy of the database cannot be replayed as a login. Roles and grants (lib/permissions.mjs)
// decide what the viewer may do; tRPC checks them (requirePerm) and the proxy keeps out anyone
// without a session.
//
// Never open a second SQLite library (node:sqlite) in this process: POSIX locks are per process,
// so closing it drops Prisma's locks and it deletes the WAL Prisma is writing to. Everything here
// goes through Prisma. Locked out? `bin/nightly user edit <name> --password-stdin` on the machine.
export const COOKIE = 'nightly_session'
export const SESSION_DAYS = 90
/** Settings the browser never sees and the generic setting.set may not write (the old single login). */
export const PRIVATE_SETTINGS = new Set<string>(['authHash', 'authSecret'])
/** The old single-login settings: bootstrap migrates them into an admin user; setting.set refuses them. */
export const AUTH_KEYS = ['authEnabled', 'authUser', 'authHash', 'authSecret'] as const

export type Viewer = { id: number; username: string; name: string; roles: string[]; roleIds: number[]; perms: Perms; admin: boolean }

// ---------- viewer ----------

const viewerCache = new Map<string, { at: number; viewer: Viewer | null }>()
const VIEWER_TTL = 5_000

/** The signed-in user for a raw cookie token, or null. Cached for a few seconds per token. */
export async function viewerForToken(token: string | undefined | null): Promise<Viewer | null> {
    if (!token || token.length < 20 || token.length > 200) return null
    const hit = viewerCache.get(token)
    if (hit && Date.now() - hit.at < VIEWER_TTL) return hit.viewer
    const viewer = await loadViewer(token)
    if (viewerCache.size > 1000) viewerCache.clear()
    viewerCache.set(token, { at: Date.now(), viewer })
    return viewer
}

async function loadViewer(token: string): Promise<Viewer | null> {
    const s = await db.session.findUnique({ where: { tokenHash: sha256(token) } })
    if (!s || s.expiresAt.getTime() < Date.now()) return null
    const v = await viewerById(s.userId)
    if (v && Date.now() - s.lastSeenAt.getTime() > 60_000) await db.session.update({ where: { id: s.id }, data: { lastSeenAt: new Date() } }).catch(() => {})
    return v
}

/** A user's resolved permissions, or null if missing or disabled. */
export async function viewerById(id: number): Promise<Viewer | null> {
    const u = await db.user.findUnique({ where: { id }, include: { roles: { include: { role: { include: { grants: true } } } }, grants: true } })
    if (!u || u.disabledAt) return null
    const perms = resolvePerms(u.roles.flatMap((r) => r.role.grants.filter((g) => g.allow).map((g) => g.perm)), u.grants)
    return { id: u.id, username: u.username, name: u.name, roles: u.roles.map((r) => r.role.name), roleIds: u.roles.map((r) => r.roleId), perms, admin: isAdmin(perms) }
}

/** Drop cached viewers (after a role, grant or user change) so the next request sees it. */
export const forgetViewers = () => viewerCache.clear()

export const cookieFrom = (header: string | null | undefined) => header?.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]*)`))?.[1] ?? ''

/** The viewer of a Request (route handlers, the proxy). */
export const viewerFromRequest = (req: Request) => viewerForToken(cookieFrom(req.headers.get('cookie')))

/** The viewer of the current server component render. */
export async function getViewer(): Promise<Viewer | null> {
    const { cookies } = await import('next/headers')
    return viewerForToken((await cookies()).get(COOKIE)?.value)
}

export const viewerCan = (v: Viewer | null | undefined, key: string) => !!v && can(v.perms, key)

// ---------- login ----------

const failures = new Map<string, number[]>()
/** Failed logins allowed per ip+username in the window before 429. */
export const RATE = { max: 10, windowMs: 15 * 60_000 }

export function rateLimited(key: string) {
    const now = Date.now()
    const list = (failures.get(key) ?? []).filter((t) => now - t < RATE.windowMs)
    if (list.length) failures.set(key, list)
    else failures.delete(key)
    return list.length >= RATE.max
}
const noteFailure = (key: string) => {
    if (failures.size > 10_000) failures.clear()
    failures.set(key, [...(failures.get(key) ?? []), Date.now()])
}

export type LoginResult = { ok: true; token: string; userId: number } | { ok: false; reason: 'invalid' | 'limited' }
const DUMMY_HASH = `${'0'.repeat(32)}:${'0'.repeat(64)}`

/** Check a username and password and open a session. */
export async function login(username: string, password: string, meta: { ip: string; userAgent: string }): Promise<LoginResult> {
    const name = username.trim().toLowerCase()
    const key = `${meta.ip}\n${name}`
    if (rateLimited(key)) return { ok: false, reason: 'limited' }
    const u = name ? await db.user.findUnique({ where: { username: name } }) : null
    // Always run scrypt, so a missing user takes as long as a wrong password.
    const ok = verifyPassword(password, u?.hash ?? DUMMY_HASH)
    if (!u || !ok || u.disabledAt) {
        noteFailure(key)
        return { ok: false, reason: 'invalid' }
    }
    failures.delete(key)
    const token = await createSession(u.id, meta)
    await db.user.update({ where: { id: u.id }, data: { lastLoginAt: new Date() } })
    return { ok: true, token, userId: u.id }
}

export async function createSession(userId: number, meta: { ip: string; userAgent: string }) {
    const token = newToken(32)
    const now = new Date()
    await db.session.create({ data: { userId, tokenHash: sha256(token), createdAt: now, lastSeenAt: now, expiresAt: new Date(now.getTime() + SESSION_DAYS * 86_400_000), ip: meta.ip.slice(0, 64), userAgent: meta.userAgent.slice(0, 300) } })
    // Expired sessions go away whenever someone signs in.
    await db.session.deleteMany({ where: { expiresAt: { lt: now } } }).catch(() => {})
    return token
}

export async function endSession(token: string) {
    if (!token) return
    viewerCache.delete(token)
    await db.session.deleteMany({ where: { tokenHash: sha256(token) } })
}

/** Sign a user out everywhere except, optionally, the current session (password change, disable, delete). */
export async function endUserSessions(userId: number, keepToken = '') {
    await db.session.deleteMany({ where: { userId, ...(keepToken ? { NOT: { tokenHash: sha256(keepToken) } } : {}) } })
    forgetViewers()
}

export const isHttps = (req: Request) => new URL(req.url).protocol === 'https:' || req.headers.get('x-forwarded-proto')?.split(',')[0].trim() === 'https'
/** Secure whenever the browser is on https (directly or behind a TLS proxy); plain-http LAN use keeps working. */
export const cookieOptions = (req: Request) => ({ httpOnly: true, sameSite: 'lax' as const, secure: isHttps(req), path: '/', maxAge: SESSION_DAYS * 86_400 })
export const clientIp = (req: Request) => req.headers.get('x-forwarded-for')?.split(',')[0].trim() || req.headers.get('x-real-ip') || 'local'

/**
 * CSRF: a state-changing request must not come from another site. Browsers send Origin on every
 * cross-site POST; it must name the host the request went to. No Origin (curl, scripts) is fine:
 * they don't hold the browser's cookie. SameSite=Lax on the cookie is the second layer.
 */
export function sameOrigin(req: Request) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true
    const origin = req.headers.get('origin')
    if (!origin) return true
    if (origin === 'null') return false
    const host = req.headers.get('x-forwarded-host')?.split(',')[0].trim() || req.headers.get('host') || new URL(req.url).host
    try { return new URL(origin).host === host } catch { return false }
}

export const safeNext = (next: string) => (next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/')

// ---------- ingest ----------

let ingestCache: { at: number; open: boolean } | null = null
/**
 * ingestOpen=true lets the ingest routes (perf, assets, usage, qa, review, heartbeats) accept posts
 * without a session or token, as a workspace that ran with the old login off did. A fresh
 * workspace starts closed: scripts then send a Bearer token.
 */
export async function ingestOpen() {
    if (ingestCache && Date.now() - ingestCache.at < 5_000) return ingestCache.open
    const row = await db.setting.findUnique({ where: { key: 'ingestOpen' } })
    ingestCache = { at: Date.now(), open: row?.value === 'true' }
    return ingestCache.open
}
export const forgetIngest = () => { ingestCache = null }

/** A post the panel trusts without a token: a signed-in viewer, or ingest left open. Others must carry a valid token. */
export async function trustedPost(req: Request) {
    return (await ingestOpen()) || !!(await viewerFromRequest(req))
}
