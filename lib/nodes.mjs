// Node registry for the CLI (`nightly node ...`, `nightly dbconn ...`, `nightly build ...`), on
// node:sqlite. Phase 1 is schema and registry only: nodes do not run work yet. A node token is
// shown once and stored as sha256; the per-node secret is generated here and never printed.
// Host names come from the operator (or their ssh config), never from this repository.
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as S from './store.mjs'
import { ensure, userRow } from './accounts.mjs'
import { projectRow } from './projects.mjs'
import { newToken, sha256 } from './passwords.mjs'
import { NODE_TYPES, LINK_AUTH, DB_KINDS, checkSpecs, parseSshConfig, probeLocal } from './node-specs.mjs'

const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/i
const checkName = (n, what = 'name') => { if (!NAME.test(String(n ?? ''))) throw new Error(`${what}: letters, digits, . _ - (max 63)`); return String(n) }
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]))
const port = (p, def) => { const n = Number(p ?? def); if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('port: 1-65535'); return n }

export const nodeRow = (db, ref) => (/^\d+$/.test(String(ref)) ? db.prepare('SELECT * FROM Node WHERE id = ?').get(Number(ref)) : db.prepare('SELECT * FROM Node WHERE name = ?').get(String(ref)))
    ?? (() => { throw new Error(`no node "${ref}" (nightly node list)`) })()
/** A node row without its token hash and secret. */
export const publicNode = ({ tokenHash, secret, ...n }) => ({ ...n, hasToken: !!tokenHash })

export function listNodes(db) {
    ensure(db)
    return db.prepare(`SELECT n.*, (SELECT count(*) FROM NodeUser WHERE nodeId = n.id) AS users FROM Node n ORDER BY n.type = 'planet' DESC, n.name`).all().map(publicNode)
}

/** Create a node; returns { node, token } (the token is only ever returned here and by rotateToken). */
export function createNode(db, { name, type = 'station', host = '', port: p, tls = false, specs = {}, notes = '' }) {
    ensure(db)
    checkName(name)
    if (!NODE_TYPES.includes(type)) throw new Error(`type: ${NODE_TYPES.join(' | ')}`)
    if (db.prepare('SELECT 1 FROM Node WHERE name = ?').get(name)) throw new Error(`node "${name}" exists`)
    const token = `nn_${newToken(24)}`
    const t = S.now()
    const id = db.prepare(`INSERT INTO Node (name, type, host, port, tls, tokenHash, secret, specs, status, notes, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?, ?) RETURNING id`)
        .get(name, type, String(host), port(p, 4001), tls ? 1 : 0, sha256(token), token, JSON.stringify(checkSpecs(specs)), String(notes), t, t).id
    return { node: publicNode(nodeRow(db, id)), token }
}

export function editNode(db, ref, patch) {
    const n = nodeRow(db, ref)
    const p = pick(patch, ['name', 'type', 'host', 'port', 'tls', 'specs', 'notes', 'status'])
    if (p.name !== undefined) checkName(p.name)
    if (p.type !== undefined && !NODE_TYPES.includes(p.type)) throw new Error(`type: ${NODE_TYPES.join(' | ')}`)
    if (p.port !== undefined) p.port = port(p.port)
    if (p.tls !== undefined) p.tls = p.tls ? 1 : 0
    if (p.specs !== undefined) p.specs = JSON.stringify(checkSpecs(p.specs))
    const keys = Object.keys(p)
    if (keys.length) db.prepare(`UPDATE Node SET ${keys.map((k) => `${k} = ?`).join(', ')}, updatedAt = ? WHERE id = ?`).run(...keys.map((k) => p[k]), S.now(), n.id)
    return publicNode(nodeRow(db, n.id))
}

export function rotateToken(db, ref) {
    const n = nodeRow(db, ref)
    const token = `nn_${newToken(24)}`
    db.prepare('UPDATE Node SET tokenHash = ?, secret = ?, updatedAt = ? WHERE id = ?').run(sha256(token), token, S.now(), n.id)
    return { node: n.name, token }
}

export function deleteNode(db, ref) {
    const n = nodeRow(db, ref)
    S.tx(db, () => {
        db.prepare('DELETE FROM NodeUser WHERE nodeId = ?').run(n.id)
        db.prepare('DELETE FROM NodeLink WHERE fromId = ? OR toId = ?').run(n.id, n.id)
        db.prepare('DELETE FROM Node WHERE id = ?').run(n.id)
    })
    return { name: n.name }
}

/** Re-probe this machine's specs into a node (keeps operator-set slots and offload kinds). */
export function probeInto(db, ref) {
    const n = nodeRow(db, ref)
    const old = JSON.parse(n.specs || '{}'), fresh = probeLocal()
    const specs = { ...fresh, ...pick(old, ['buildSlots', 'heavySlots', 'offloadKinds']) }
    db.prepare('UPDATE Node SET specs = ?, status = ?, lastSeenAt = ?, updatedAt = ? WHERE id = ?').run(JSON.stringify(specs), 'online', S.now(), S.now(), n.id)
    return publicNode(nodeRow(db, n.id))
}

/** This machine as the Planet (named after its hostname), created if missing; specs probed. */
export function seedPlanet(db) {
    ensure(db)
    const name = os.hostname().split('.')[0].toLowerCase()
    const have = db.prepare("SELECT * FROM Node WHERE type = 'planet' LIMIT 1").get()
    const n = have ?? createNode(db, { name, type: 'planet', host: 'localhost', notes: 'This machine (seeded).' }).node
    return probeInto(db, n.id)
}

/** A Station from an ssh config alias. Host/user/port go into the DB only; no credentials are read. */
export function importSsh(db, alias, { configFile = path.join(os.homedir(), '.ssh/config'), name } = {}) {
    ensure(db)
    const cfg = parseSshConfig(readFileSync(configFile, 'utf8'))[alias]
    if (!cfg) throw new Error(`no Host "${alias}" in ${configFile}`)
    const nodeName = checkName(name ?? alias)
    const existing = db.prepare('SELECT id FROM Node WHERE name = ?').get(nodeName)
    const host = cfg.hostname ?? alias
    const res = existing ? { node: editNode(db, existing.id, { host }), token: null } : createNode(db, { name: nodeName, type: 'station', host, notes: `Imported from ssh alias ${alias}.` })
    if (cfg.user) {
        const planet = db.prepare("SELECT id FROM Node WHERE type = 'planet' LIMIT 1").get()
        if (planet) db.prepare(`INSERT INTO NodeLink (fromId, toId, username, auth, status, createdAt) VALUES (?, ?, ?, 'ssh-key', 'unknown', ?)
            ON CONFLICT(fromId, toId, username) DO NOTHING`).run(planet.id, res.node.id, cfg.user, S.now())
    }
    return { ...res, sshUser: cfg.user ?? null, sshPort: cfg.port ?? 22 }
}

// Node users: which panel user may use which node, as which OS username.
export function addNodeUser(db, ref, username, osUser) {
    const n = nodeRow(db, ref), u = userRow(db, username)
    db.prepare('INSERT INTO NodeUser (nodeId, userId, username) VALUES (?, ?, ?) ON CONFLICT(nodeId, userId) DO UPDATE SET username = excluded.username').run(n.id, u.id, checkName(osUser ?? u.username, 'os user'))
    return listNodeUsers(db, n.name)
}
export const removeNodeUser = (db, ref, username) => { const n = nodeRow(db, ref), u = userRow(db, username); db.prepare('DELETE FROM NodeUser WHERE nodeId = ? AND userId = ?').run(n.id, u.id); return listNodeUsers(db, n.name) }
export const listNodeUsers = (db, ref) => { const n = nodeRow(db, ref); return db.prepare('SELECT nu.id, u.username AS user, nu.username AS osUser FROM NodeUser nu JOIN User u ON u.id = nu.userId WHERE nu.nodeId = ? ORDER BY u.username').all(n.id) }

// Node links: node A can reach node B as an OS user (ssh key or password; no secret is stored here).
export function addLink(db, from, to, username, auth = 'ssh-key') {
    const a = nodeRow(db, from), b = nodeRow(db, to)
    if (a.id === b.id) throw new Error('a node cannot link to itself')
    if (!LINK_AUTH.includes(auth)) throw new Error(`auth: ${LINK_AUTH.join(' | ')}`)
    db.prepare(`INSERT INTO NodeLink (fromId, toId, username, auth, status, createdAt) VALUES (?, ?, ?, ?, 'unknown', ?)
        ON CONFLICT(fromId, toId, username) DO UPDATE SET auth = excluded.auth`).run(a.id, b.id, checkName(username, 'username'), auth, S.now())
    return listLinks(db)
}
export const listLinks = (db) => { ensure(db); return db.prepare(`SELECT l.id, a.name AS "from", b.name AS "to", l.username, l.auth, l.status, l.checkedAt
    FROM NodeLink l JOIN Node a ON a.id = l.fromId JOIN Node b ON b.id = l.toId ORDER BY a.name, b.name`).all() }
export const removeLink = (db, id) => { const n = db.prepare('DELETE FROM NodeLink WHERE id = ?').run(Number(id)).changes; if (!n) throw new Error(`no link ${id}`); return { id: Number(id) } }

// Database connections (ClickHouse and friends). secretRef names an env var or secret store key; the secret itself is never stored.
export const listDbConns = (db) => { ensure(db); return db.prepare('SELECT * FROM DbConnection ORDER BY name').all() }
export function createDbConn(db, { name, kind = 'clickhouse', host = '', port: p, database = '', username = '', secretRef = '', options = {} }) {
    ensure(db)
    checkName(name)
    if (!DB_KINDS.includes(kind)) throw new Error(`kind: ${DB_KINDS.join(' | ')}`)
    if (secretRef && !/^[A-Za-z_/~][A-Za-z0-9_.:/-]*$/.test(secretRef)) throw new Error('secretRef: an env var or secret key name, not the secret')
    const t = S.now()
    return db.prepare(`INSERT INTO DbConnection (name, kind, host, port, database, username, secretRef, options, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`).get(name, kind, String(host), port(p, kind === 'clickhouse' ? 8123 : 5432), String(database), String(username), String(secretRef), JSON.stringify(options), t, t)
}
export const deleteDbConn = (db, name) => { const n = db.prepare('DELETE FROM DbConnection WHERE name = ?').run(String(name)).changes; if (!n) throw new Error(`no db connection "${name}"`); return { name } }

// Build configs per project: a command that a node with a matching kind may run (phase 1: registry only).
export const listBuilds = (db, slug) => { ensure(db); return db.prepare(`SELECT b.*, p.slug AS project FROM BuildConfig b JOIN Project p ON p.id = b.projectId ${slug ? 'WHERE p.slug = ?' : ''} ORDER BY p.slug, b.name`).all(...(slug ? [slug] : [])) }
export function setBuild(db, slug, name, { command, heavy, nodeKinds, timeout, enabled }) {
    ensure(db)
    const p = projectRow(db, slug)
    checkName(name)
    const t = S.now()
    const cur = db.prepare('SELECT * FROM BuildConfig WHERE projectId = ? AND name = ?').get(p.id, name)
    const v = {
        command: String(command ?? cur?.command ?? ''), heavy: (heavy ?? cur?.heavy ?? 0) ? 1 : 0,
        nodeKinds: String(nodeKinds ?? cur?.nodeKinds ?? 'build'), timeout: Number(timeout ?? cur?.timeout ?? 0), enabled: (enabled ?? cur?.enabled ?? 1) ? 1 : 0,
    }
    if (!v.command) throw new Error('command required')
    if (!Number.isInteger(v.timeout) || v.timeout < 0) throw new Error('timeout: seconds >= 0 (0 = unlimited)')
    db.prepare(`INSERT INTO BuildConfig (projectId, name, command, heavy, nodeKinds, timeout, enabled, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(projectId, name) DO UPDATE SET command = excluded.command, heavy = excluded.heavy, nodeKinds = excluded.nodeKinds, timeout = excluded.timeout, enabled = excluded.enabled, updatedAt = excluded.updatedAt`)
        .run(p.id, name, v.command, v.heavy, v.nodeKinds, v.timeout, v.enabled, t, t)
    return listBuilds(db, slug).find((b) => b.name === name)
}
export const deleteBuild = (db, slug, name) => { const p = projectRow(db, slug); const n = db.prepare('DELETE FROM BuildConfig WHERE projectId = ? AND name = ?').run(p.id, String(name)).changes; if (!n) throw new Error(`no build "${name}" on ${slug}`); return { project: slug, name } }
