// Find Docker Compose projects with database services and register them as DbConnection rows. Credentials come
// from the project's .env only to fill host/port/db/user; the password is never stored, only the variable name
// (secretRef = "<file>:<VAR>"). Existing rows are left alone.
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const COMPOSE = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']
const KINDS = [[/clickhouse/i, 'clickhouse', 8123], [/postgres|timescale/i, 'postgres', 5432], [/mysql|mariadb/i, 'mysql', 3306], [/redis|valkey/i, 'redis', 6379], [/mongo/i, 'mongodb', 27017]]
const VAR = { clickhouse: ['CLICKHOUSE_DB', 'CLICKHOUSE_USER', 'CLICKHOUSE_PASSWORD'], postgres: ['POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD'], mysql: ['MYSQL_DATABASE', 'MYSQL_USER', 'MYSQL_PASSWORD'] }

export function parseEnv(text) {
    const o = {}
    for (const l of text.split('\n')) { const m = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/.exec(l); if (m && !l.trim().startsWith('#')) o[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2') }
    return o
}
const subst = (v, env) => String(v ?? '').replace(/\$\{(\w+)(?::?-([^}]*))?\}/g, (_, k, d) => env[k] ?? d ?? '')

/** Crude compose reader: service names, images, published ports, environment entries. */
export function parseCompose(text) {
    const services = {}
    let inServices = false, cur = null, sect = null
    for (const raw of text.split('\n')) {
        const line = raw.replace(/\s+#.*$/, '')
        if (!line.trim()) continue
        const ind = line.length - line.trimStart().length, t = line.trim()
        if (ind === 0) { inServices = /^services:/.test(t); cur = null; continue }
        if (!inServices) continue
        if (ind <= 4 && /^[\w.-]+:\s*$/.test(t) && (cur === null || ind <= (cur.ind))) { cur = { ind, image: '', ports: [], env: {} }; services[t.slice(0, -1)] = cur; sect = null; continue }
        if (!cur) continue
        let m
        if ((m = /^image:\s*(.+)$/.exec(t))) cur.image = m[1].replace(/["']/g, '')
        else if ((m = /^(ports|environment):\s*$/.exec(t))) sect = m[1]
        else if (sect === 'environment' && (m = /^([\w.-]+):\s*(.*)$/.exec(t))) cur.env[m[1]] = m[2].replace(/["']/g, '')
        else if (/^[\w.-]+:/.test(t) && !t.startsWith('-')) sect = null
        else if (sect === 'ports' && t.startsWith('-')) cur.ports.push(t.slice(1).trim().replace(/["']/g, ''))
        else if (sect === 'environment' && t.startsWith('-')) { const e = /^-\s*([\w]+)=?(.*)$/.exec(t); if (e) cur.env[e[1]] = e[2].replace(/["']/g, '') }
    }
    return services
}

export function detectCompose(dir) {
    const file = COMPOSE.map((f) => path.join(/*turbopackIgnore: true*/ dir, f)).find(existsSync)
    if (!file) return []
    const env = existsSync(path.join(dir, '.env')) ? parseEnv(readFileSync(path.join(dir, '.env'), 'utf8')) : {}
    const found = []
    for (const [svc, s] of Object.entries(parseCompose(readFileSync(file, 'utf8')))) {
        const hit = KINDS.find(([re]) => re.test(s.image) || re.test(svc))
        if (!hit) continue
        const [, kind, defPort] = hit
        const host = (s.ports[0] && /(\d+):\d+/.exec(subst(s.ports[0], env))) ? Number(/(\d+):\d+/.exec(subst(s.ports[0], env))[1]) : defPort
        const [vDb, vUser, vPw] = VAR[kind] ?? []
        const pick = (v) => { const raw = s.env[v] ?? env[v] ?? ''; return subst(raw, env) }
        found.push({ name: `${path.basename(dir)}-${svc}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 63), kind, host: 'localhost', port: host, database: vDb ? pick(vDb) : '', username: vUser ? pick(vUser) : '', secretRef: vPw ? `${path.join(dir, '.env')}:${vPw}`.replace(/[^A-Za-z0-9_.:/-]/g, '_') : '', file })
    }
    return found
}

/** Register everything found under each dir; returns { created: [names], existing: [names] }. */
export async function detectAndRegister(db, dirs) {
    const N = await import('./nodes.mjs') // node:sqlite stays out of the panel process; the panel only calls detectCompose
    const out = { created: [], existing: [] }
    for (const d of dirs) for (const c of detectCompose(d)) {
        if (db.prepare('SELECT 1 FROM DbConnection WHERE name = ?').get(c.name)) { out.existing.push(c.name); continue }
        const { file, ...row } = c
        N.createDbConn(db, { ...row, options: { source: 'compose', file } })
        out.created.push(c.name)
    }
    return out
}
