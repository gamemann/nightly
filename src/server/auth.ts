import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { db } from './db'

// Optional login, switched on in Settings (off by default). Stored as settings:
//   authEnabled  'true' to require a login
//   authUser     optional username ('' = password only)
//   authHash     scrypt of the password, 'salt:hash' in hex
//   authSecret   random key the session cookie is signed with
// The proxy reads them through the panel's Prisma client (the proxy runs on Node), cached for a
// moment. Never open a second SQLite library (node:sqlite) in this process: POSIX locks are
// per process, so closing it drops Prisma's locks and it deletes the WAL Prisma is writing to.
// Locked out? `bin/nightly set-setting authEnabled false` on the machine.
export const COOKIE = 'nightly_session'
export const AUTH_KEYS = ['authEnabled', 'authUser', 'authHash', 'authSecret'] as const
/** Settings the browser never sees and the generic setting.set may not write. */
export const PRIVATE_SETTINGS = new Set<string>(['authHash', 'authSecret'])

export type AuthConfig = { enabled: boolean; user: string; hash: string; secret: string }

let cache: { at: number; cfg: AuthConfig } | null = null
export async function readAuth(): Promise<AuthConfig> {
    if (cache && Date.now() - cache.at < 2000) return cache.cfg
    const rows = await db.setting.findMany({ where: { key: { in: [...AUTH_KEYS] } } })
    const v = Object.fromEntries(rows.map((r) => [r.key, r.value]))
    // On without a password set would lock everyone out with nothing to type: treat it as off.
    const cfg = { enabled: v.authEnabled === 'true' && !!v.authHash && !!v.authSecret, user: v.authUser ?? '', hash: v.authHash ?? '', secret: v.authSecret ?? '' }
    cache = { at: Date.now(), cfg }
    return cfg
}
export const forgetAuth = () => { cache = null }

export function hashPassword(password: string) {
    const salt = randomBytes(16)
    return `${salt.toString('hex')}:${scryptSync(password, salt, 32).toString('hex')}`
}

export function checkLogin(cfg: AuthConfig, user: string, password: string) {
    const [salt, hash] = cfg.hash.split(':')
    if (!salt || !hash) return false
    const got = scryptSync(password, Buffer.from(salt, 'hex'), 32)
    const pwOk = timingSafeEqual(got, Buffer.from(hash, 'hex'))
    const userOk = safeEqual(user.trim(), cfg.user)
    return pwOk && userOk
}

/** What the cookie must hold: changes whenever the user, the password or the secret does. */
export const sessionToken = (cfg: AuthConfig) => createHmac('sha256', cfg.secret).update(`${cfg.user}\n${cfg.hash}`).digest('hex')

export function safeEqual(a: string, b: string) {
    const x = Buffer.from(a), y = Buffer.from(b)
    return x.length === y.length && timingSafeEqual(x, y)
}

export const newSecret = () => randomBytes(32).toString('hex')
