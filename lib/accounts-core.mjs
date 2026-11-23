// The parts of accounts that both data layers share and that need no database handle: the
// migration statements and the first-start plan. lib/accounts.mjs (CLI, node:sqlite) and
// src/server/bootstrap.ts (panel, Prisma) both run them. No node:sqlite import here, so the
// panel may load it.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashPassword, randomPassword } from './passwords.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const MIGRATION = path.join(ROOT, 'prisma', 'migrations', '20261201000000_users_projects_nodes', 'migration.sql')

/** The CREATE TABLE/INDEX IF NOT EXISTS statements of the users/projects/nodes migration. */
export function migrationStatements(file = MIGRATION) {
    const sql = readFileSync(file, 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    return sql.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean)
}

/**
 * What to do on first start, when there are no users yet.
 *  - The old single login (settings authUser/authHash) becomes an admin with the same password hash.
 *  - Otherwise NIGHTLY_ADMIN_USER / NIGHTLY_ADMIN_PASSWORD seed the admin; with no password a random
 *    one is generated and returned so the caller prints it once.
 *  - ingestOpen: a workspace that ran with the login off (authEnabled != 'true') and already has data
 *    keeps its scripts posting without a credential; a fresh workspace starts closed.
 * settings: { authEnabled, authUser, authHash } (strings or null). env: process.env. hasData: any Item rows.
 */
export function bootstrapPlan({ settings = {}, env = {}, hasData = false } = {}) {
    const legacyHash = settings.authHash && /^[0-9a-f]{32}:[0-9a-f]{64}$/.test(settings.authHash) ? settings.authHash : ''
    const ingestOpen = hasData && settings.authEnabled !== 'true'
    if (legacyHash) {
        const username = cleanName(settings.authUser) || 'admin'
        return { username, hash: legacyHash, password: '', source: 'legacy', ingestOpen }
    }
    const username = cleanName(env.NIGHTLY_ADMIN_USER) || 'admin'
    const given = env.NIGHTLY_ADMIN_PASSWORD ? String(env.NIGHTLY_ADMIN_PASSWORD) : ''
    const password = given || randomPassword()
    return { username, hash: hashPassword(password), password: given ? '' : password, source: given ? 'env' : 'generated', ingestOpen }
}

const cleanName = (s) => {
    const v = String(s ?? '').trim().toLowerCase()
    return /^[a-z0-9][a-z0-9._-]{1,31}$/.test(v) ? v : ''
}
