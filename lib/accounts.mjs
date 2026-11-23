// Users, roles and permission grants for the CLI (`nightly user ...`, `nightly role ...`), on
// node:sqlite. The panel does the same through Prisma (src/server/accounts.ts); the rules
// (permission keys, default roles, password format, first-start plan) are shared from
// lib/permissions.mjs, lib/passwords.mjs and lib/accounts-core.mjs.
import * as S from './store.mjs'
import { DEFAULT_ROLES, validGrant, resolvePerms } from './permissions.mjs'
import { checkUsername, hashPassword } from './passwords.mjs'
import { bootstrapPlan, migrationStatements } from './accounts-core.mjs'

/** Create the users/projects/nodes tables if missing (idempotent). */
export function ensure(db) {
    for (const st of migrationStatements()) db.exec(st)
}

/** The builtin roles and their grants, created if missing (grants of an existing role are left alone). */
export function ensureRoles(db) {
    ensure(db)
    for (const [name, r] of Object.entries(DEFAULT_ROLES)) {
        if (db.prepare('SELECT 1 FROM Role WHERE name = ?').get(name)) continue
        const id = db.prepare('INSERT INTO Role (name, description, builtin, createdAt) VALUES (?, ?, 1, ?) RETURNING id').get(name, r.description, S.now()).id
        for (const p of r.grants) db.prepare('INSERT INTO PermissionGrant (roleId, perm, allow) VALUES (?, ?, 1)').run(id, p)
    }
}

/** First start: roles, then (if no user exists) the admin from the old login, env or a generated password. Returns the plan or null. */
export function bootstrap(db, env = process.env) {
    ensureRoles(db)
    if (db.prepare('SELECT 1 FROM User LIMIT 1').get()) return null
    const settings = Object.fromEntries(['authEnabled', 'authUser', 'authHash'].map((k) => [k, S.getSetting(db, k)]))
    const hasData = !!db.prepare('SELECT 1 FROM Item LIMIT 1').get()
    const plan = bootstrapPlan({ settings, env, hasData })
    S.tx(db, () => {
        const t = S.now()
        const id = db.prepare('INSERT INTO User (username, name, hash, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?) RETURNING id').get(plan.username, 'Administrator', plan.hash, t, t).id
        db.prepare('INSERT INTO UserRole (userId, roleId) SELECT ?, id FROM Role WHERE name = ?').run(id, 'admin')
        if (plan.ingestOpen && S.getSetting(db, 'ingestOpen') == null) S.setSetting(db, 'ingestOpen', 'true')
    })
    return plan
}

const roleId = (db, name) => db.prepare('SELECT id FROM Role WHERE name = ?').get(String(name))?.id ?? (() => { throw new Error(`no role "${name}" (nightly role list)`) })()
export const userRow = (db, username) => db.prepare('SELECT * FROM User WHERE username = ?').get(String(username).toLowerCase()) ?? (() => { throw new Error(`no user "${username}" (nightly user list)`) })()

export function listUsers(db) {
    ensure(db)
    return db.prepare(`SELECT u.id, u.username, u.name, u.disabledAt, u.lastLoginAt, u.createdAt,
        COALESCE((SELECT group_concat(r.name, ',') FROM UserRole ur JOIN Role r ON r.id = ur.roleId WHERE ur.userId = u.id), '') AS roles
        FROM User u ORDER BY u.username`).all()
}

export function createUser(db, { username, password, name = '', roles = ['user'] }) {
    ensureRoles(db)
    const u = checkUsername(username)
    if (db.prepare('SELECT 1 FROM User WHERE username = ?').get(u)) throw new Error(`user "${u}" exists`)
    const hash = hashPassword(password)
    const ids = roles.map((r) => roleId(db, r))
    return S.tx(db, () => {
        const t = S.now()
        const id = db.prepare('INSERT INTO User (username, name, hash, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?) RETURNING id').get(u, String(name), hash, t, t).id
        for (const r of ids) db.prepare('INSERT INTO UserRole (userId, roleId) VALUES (?, ?)').run(id, r)
        return { id, username: u, roles }
    })
}

/** Refuse a change that would leave no enabled admin. */
function keepAnAdmin(db, exceptUserId) {
    const n = db.prepare(`SELECT count(*) n FROM User u JOIN UserRole ur ON ur.userId = u.id JOIN Role r ON r.id = ur.roleId
        WHERE r.name = 'admin' AND u.disabledAt IS NULL AND u.id != ?`).get(exceptUserId).n
    if (!n) throw new Error('that would leave no enabled admin')
}
const isAdminUser = (db, id) => !!db.prepare("SELECT 1 FROM UserRole ur JOIN Role r ON r.id = ur.roleId WHERE ur.userId = ? AND r.name = 'admin'").get(id)

export function editUser(db, username, { password, name, roles, disabled }) {
    ensureRoles(db)
    const u = userRow(db, username)
    return S.tx(db, () => {
        const t = S.now()
        if (password !== undefined) {
            db.prepare('UPDATE User SET hash = ?, updatedAt = ? WHERE id = ?').run(hashPassword(password), t, u.id)
            db.prepare('DELETE FROM Session WHERE userId = ?').run(u.id)
        }
        if (name !== undefined) db.prepare('UPDATE User SET name = ?, updatedAt = ? WHERE id = ?').run(String(name), t, u.id)
        if (roles !== undefined) {
            const ids = roles.map((r) => roleId(db, r))
            if (isAdminUser(db, u.id) && !roles.includes('admin')) keepAnAdmin(db, u.id)
            db.prepare('DELETE FROM UserRole WHERE userId = ?').run(u.id)
            for (const r of ids) db.prepare('INSERT INTO UserRole (userId, roleId) VALUES (?, ?)').run(u.id, r)
        }
        if (disabled !== undefined) {
            if (disabled && isAdminUser(db, u.id)) keepAnAdmin(db, u.id)
            db.prepare('UPDATE User SET disabledAt = ?, updatedAt = ? WHERE id = ?').run(disabled ? t : null, t, u.id)
            if (disabled) db.prepare('DELETE FROM Session WHERE userId = ?').run(u.id)
        }
        return { id: u.id, username: u.username }
    })
}

export function deleteUser(db, username) {
    const u = userRow(db, username)
    if (isAdminUser(db, u.id)) keepAnAdmin(db, u.id)
    db.prepare('DELETE FROM User WHERE id = ?').run(u.id)
    return { id: u.id, username: u.username }
}

/** A user's resolved permissions: { allow, deny } plus their role names. */
export function userPerms(db, username) {
    const u = userRow(db, username)
    const roleGrants = db.prepare('SELECT g.perm FROM PermissionGrant g JOIN UserRole ur ON ur.roleId = g.roleId WHERE ur.userId = ? AND g.allow = 1').all(u.id).map((r) => r.perm)
    const userGrants = db.prepare('SELECT perm, allow FROM PermissionGrant WHERE userId = ?').all(u.id).map((r) => ({ perm: r.perm, allow: !!r.allow }))
    const roles = db.prepare('SELECT r.name FROM UserRole ur JOIN Role r ON r.id = ur.roleId WHERE ur.userId = ?').all(u.id).map((r) => r.name)
    return { username: u.username, roles, ...resolvePerms(roleGrants, userGrants) }
}

export function listRoles(db) {
    ensureRoles(db)
    return db.prepare(`SELECT r.id, r.name, r.description, r.builtin,
        COALESCE((SELECT group_concat(perm, ',') FROM PermissionGrant g WHERE g.roleId = r.id), '') AS grants,
        (SELECT count(*) FROM UserRole ur WHERE ur.roleId = r.id) AS users FROM Role r ORDER BY r.builtin DESC, r.name`).all()
}

export function createRole(db, { name, description = '', grants = [] }) {
    ensureRoles(db)
    const n = String(name ?? '').trim()
    if (!/^[\w .-]{2,40}$/.test(n)) throw new Error('role name: 2-40 letters, digits, space . _ -')
    for (const g of grants) if (!validGrant(g)) throw new Error(`unknown permission "${g}" (nightly role perms)`)
    if (db.prepare('SELECT 1 FROM Role WHERE name = ?').get(n)) throw new Error(`role "${n}" exists`)
    return S.tx(db, () => {
        const id = db.prepare('INSERT INTO Role (name, description, builtin, createdAt) VALUES (?, ?, 0, ?) RETURNING id').get(n, String(description), S.now()).id
        for (const g of new Set(grants)) db.prepare('INSERT INTO PermissionGrant (roleId, perm, allow) VALUES (?, ?, 1)').run(id, g)
        return { id, name: n }
    })
}

export function deleteRole(db, name) {
    const r = db.prepare('SELECT * FROM Role WHERE name = ?').get(String(name)) ?? (() => { throw new Error(`no role "${name}"`) })()
    if (r.builtin) throw new Error(`"${name}" is a builtin role`)
    db.prepare('DELETE FROM Role WHERE id = ?').run(r.id)
    return { id: r.id, name: r.name }
}

/** Grant (allow) or deny a permission to a role (`role:<name>`) or a user (`user:<name>`); revoke removes the row. */
export function setGrant(db, target, perm, mode = 'allow') {
    ensureRoles(db)
    if (!validGrant(perm)) throw new Error(`unknown permission "${perm}" (nightly role perms)`)
    const [kind, name] = String(target).split(':')
    if (kind === 'role') {
        const id = roleId(db, name)
        if (name === 'admin') throw new Error('the admin role always has *')
        if (mode === 'deny') throw new Error('roles only allow; deny a user instead')
        if (mode === 'revoke') db.prepare('DELETE FROM PermissionGrant WHERE roleId = ? AND perm = ?').run(id, perm)
        else db.prepare('INSERT INTO PermissionGrant (roleId, perm, allow) VALUES (?, ?, 1) ON CONFLICT DO NOTHING').run(id, perm)
    } else if (kind === 'user') {
        const id = userRow(db, name).id
        if (mode === 'revoke') db.prepare('DELETE FROM PermissionGrant WHERE userId = ? AND perm = ?').run(id, perm)
        else db.prepare('INSERT INTO PermissionGrant (userId, perm, allow) VALUES (?, ?, ?) ON CONFLICT(userId, perm) DO UPDATE SET allow = excluded.allow').run(id, perm, mode === 'deny' ? 0 : 1)
    } else throw new Error('target: role:<name> or user:<name>')
    return { target, perm, mode }
}
