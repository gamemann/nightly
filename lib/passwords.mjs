// Password hashing and session tokens, shared by the CLI (`nightly user ...`) and the panel
// (src/server/auth.ts). scrypt from node:crypto; the stored form is `salt:hash` (hex), the same
// format the old single-login settings (authHash) used, so a migrated hash keeps working.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const KEYLEN = 32
export const MIN_PASSWORD = 8

export function hashPassword(password) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw new Error(`password: at least ${MIN_PASSWORD} characters`)
    const salt = randomBytes(16)
    return `${salt.toString('hex')}:${scryptSync(password, salt, KEYLEN).toString('hex')}`
}

/** Constant-time check of a password against a stored `salt:hash`. A malformed hash never matches. */
export function verifyPassword(password, stored) {
    const [salt, hex] = String(stored ?? '').split(':')
    if (!salt || !hex || typeof password !== 'string') return false
    const want = Buffer.from(hex, 'hex')
    if (want.length !== KEYLEN) return false
    // The salt is used as raw bytes, as the old single login (authHash) did, so migrated hashes verify.
    return timingSafeEqual(scryptSync(password, Buffer.from(salt, 'hex'), KEYLEN), want)
}

export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex')

/** A random secret for a cookie or node token (url-safe). */
export const newToken = (bytes = 32) => randomBytes(bytes).toString('base64url')

/** A random password for a seeded account: 20 url-safe characters. */
export const randomPassword = () => randomBytes(15).toString('base64url')

export function safeEqual(a, b) {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b))
    return x.length === y.length && timingSafeEqual(x, y)
}

export const USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/
export function checkUsername(u) {
    const s = String(u ?? '').trim().toLowerCase()
    if (!USERNAME.test(s)) throw new Error('username: 2-32 of a-z 0-9 . _ -, starting with a letter or digit')
    return s
}
