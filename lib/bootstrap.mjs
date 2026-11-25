// First-start setup for every deployment (bare metal, systemd, Docker Compose): make the SQLite file match
// prisma/schema.prisma (the equivalent of `prisma db push`, additive only: it creates tables and adds columns,
// never drops or rewrites anything), create the usage tables, create the ClickHouse database and tables when
// ClickHouse is configured, seed roles and the first admin, and register the database connections found in
// the environment. Plain node:sqlite (the panel process must not load node:sqlite, so src/instrumentation.ts
// runs this file as a child process, and the Docker entrypoint and install scripts run it directly).
//
//   node lib/bootstrap.mjs [--json]      exit 0 when the database is ready; ClickHouse trouble is a warning
import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const SCHEMA = path.join(ROOT, 'prisma', 'schema.prisma')
export const BASELINE = path.join(ROOT, 'prisma', 'baseline.sql')

const splitSql = (sql) => sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean)

const SQL_TYPE = { String: 'TEXT', Int: 'INTEGER', BigInt: 'BIGINT', Boolean: 'BOOLEAN', DateTime: 'DATETIME', Float: 'REAL', Decimal: 'DECIMAL', Json: 'JSONB', Bytes: 'BLOB' }

/** Scalar columns of every model in a schema.prisma text: { Model: [{ name, type, optional, def }] }. */
export function parseSchemaColumns(text) {
    const models = {}
    const names = [...text.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1])
    for (const m of text.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
        const cols = []
        for (const raw of m[2].split('\n')) {
            const line = raw.replace(/\/\/.*$/, '').trim()
            if (!line || line.startsWith('@@')) continue
            const f = /^(\w+)\s+(\w+)(\?|\[\])?\s*(.*)$/.exec(line)
            if (!f) continue
            const [, name, type, mod, rest] = f
            if (mod === '[]' || names.includes(type) || !SQL_TYPE[type]) continue // relation or enum
            if (/@id\b/.test(rest)) continue
            const d = /@default\(((?:[^()]|\([^)]*\))*)\)/.exec(rest)?.[1]
            let def = null
            if (d != null) {
                if (/^autoincrement\(/.test(d)) def = null
                else if (/^now\(/.test(d)) def = `'${new Date().toISOString()}'`
                else if (d === 'true') def = '1'
                else if (d === 'false') def = '0'
                else if (/^"(.*)"$/.test(d)) def = `'${d.slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "''")}'`
                else if (/^-?[\d.]+$/.test(d)) def = d
            }
            cols.push({ name, type: SQL_TYPE[type], optional: mod === '?', def })
        }
        models[m[1]] = cols
    }
    return models
}

const q = (s) => `"${String(s).replace(/"/g, '""')}"`

/**
 * Bring the SQLite file up to the schema. Returns { created: [tables], added: ['Table.col'], skipped: ['Table.col: why'] }.
 * Additive and idempotent. A NOT NULL column without a default cannot be added to a table with rows; it is reported in skipped.
 */
export function syncSchema(db, { baseline = BASELINE, schema = SCHEMA } = {}) {
    const out = { created: [], added: [], skipped: [] }
    const have = () => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name))
    const stmts = splitSql(readFileSync(baseline, 'utf8'))
    const before = have()
    for (const s of stmts.filter((x) => /^CREATE TABLE/i.test(x))) db.exec(s.replace(/^CREATE TABLE\s+/i, 'CREATE TABLE IF NOT EXISTS '))
    for (const t of have()) if (!before.has(t)) out.created.push(t)
    const models = parseSchemaColumns(readFileSync(schema, 'utf8'))
    for (const [table, cols] of Object.entries(models)) {
        const present = new Set(db.prepare(`PRAGMA table_info(${q(table)})`).all().map((r) => r.name))
        if (!present.size) continue
        for (const c of cols) {
            if (present.has(c.name)) continue
            const empty = !db.prepare(`SELECT 1 FROM ${q(table)} LIMIT 1`).get()
            if (!c.optional && c.def == null && !empty) { out.skipped.push(`${table}.${c.name}: NOT NULL without a default on a table with rows`); continue }
            db.exec(`ALTER TABLE ${q(table)} ADD COLUMN ${q(c.name)} ${c.type}${c.optional ? '' : ' NOT NULL'}${c.def != null ? ` DEFAULT ${c.def}` : ''}`)
            out.added.push(`${table}.${c.name}`)
        }
    }
    for (const s of stmts.filter((x) => /^CREATE (UNIQUE )?INDEX/i.test(x))) {
        try { db.exec(s.replace(/^CREATE (UNIQUE )?INDEX\s+/i, (_, u) => `CREATE ${u ?? ''}INDEX IF NOT EXISTS `)) } catch (e) { out.skipped.push(`index: ${e.message}`) }
    }
    return out
}

/** Docker Compose / env database connections (a ClickHouse the panel was given) as DbConnection rows. */
export function envDbConnections(env = process.env) {
    const out = []
    if (env.NIGHTLY_CLICKHOUSE_URL) {
        let u
        try { u = new URL(env.NIGHTLY_CLICKHOUSE_URL) } catch { return out }
        out.push({ name: 'clickhouse', kind: 'clickhouse', host: u.hostname, port: Number(u.port) || (u.protocol === 'https:' ? 8443 : 8123), database: env.NIGHTLY_CLICKHOUSE_DB || 'nightly_usage', username: env.NIGHTLY_CLICKHOUSE_USER || 'default', secretRef: 'NIGHTLY_CLICKHOUSE_PASSWORD', options: { source: 'env' } })
    }
    return out
}

export function upsertDbConnection(db, c) {
    if (db.prepare('SELECT 1 FROM DbConnection WHERE name = ?').get(c.name)) return false
    const t = new Date().toISOString()
    db.prepare('INSERT INTO DbConnection (name, kind, host, port, database, username, secretRef, options, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(c.name, c.kind, c.host ?? '', c.port ?? 0, c.database ?? '', c.username ?? '', c.secretRef ?? '', JSON.stringify(c.options ?? {}), t, t)
    return true
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Full bootstrap. opts: { dbFile, env, log, chWaitSec, fetchImpl }. Returns a report; throws only when SQLite cannot be prepared.
 */
export async function bootstrap({ dbFile, env = process.env, log = () => {}, chWaitSec, fetchImpl } = {}) {
    const S = await import('./store.mjs')
    const file = dbFile || env.NIGHTLY_DB || S.DB_PATH
    mkdirSync(path.dirname(file), { recursive: true })
    const report = { db: file, schema: null, admin: null, connections: [], clickhouse: { configured: false, ok: false, tables: 0, error: '' } }
    const fresh = !existsSync(file)
    const db = new DatabaseSync(file)
    try {
        db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
        report.schema = syncSchema(db)
        log(`${fresh ? 'created' : 'checked'} ${file}: ${report.schema.created.length} tables created, ${report.schema.added.length} columns added${report.schema.skipped.length ? `, ${report.schema.skipped.length} skipped` : ''}`)
        for (const s of report.schema.skipped) log(`  skipped ${s}`)
        try {
            const M = await import('./project-map.mjs')
            if (M.needsMapping(db)) { const r = M.mapProjects(db); report.mapping = { links: r.tasks.links, packLinks: r.packs.links }; log(`mapped tasks and packs to projects: ${r.tasks.links} task links, ${r.packs.links} pack links`) }
        } catch (e) { log(`WARNING project mapping failed: ${e.message}`) }
        try { (await import('./assets-kinds.mjs')).ensure(db) } catch (e) { log(`WARNING asset kind columns: ${e.message}`) }
        const U = await import('./usage-store.mjs')
        U.ensure(db)
        const A = await import('./accounts.mjs')
        const plan = A.bootstrap(db, env)
        if (plan) {
            report.admin = { username: plan.username, source: plan.source, password: plan.password }
            log(`created admin "${plan.username}" (${plan.source})${plan.password ? ` with generated password ${plan.password} (shown once)` : ''}`)
        }
        for (const c of envDbConnections(env)) if (upsertDbConnection(db, c)) { report.connections.push(c.name); log(`registered database connection "${c.name}"`) }
        let cfg = null
        try { cfg = (await import('./usage-ch.mjs')).chConfig((k) => S.getSetting(db, k), env) } catch (e) { report.clickhouse.error = e.message }
        if (cfg?.enabled) {
            report.clickhouse.configured = true
            const deadline = Date.now() + (chWaitSec ?? Number(env.NIGHTLY_BOOTSTRAP_CH_WAIT ?? 30)) * 1000
            for (;;) {
                try { report.clickhouse.tables = await U.ensureCh(cfg, { fetchImpl }); report.clickhouse.ok = true; report.clickhouse.error = ''; break } catch (e) {
                    report.clickhouse.error = e.message
                    if (Date.now() >= deadline) break
                    await sleep(1000)
                }
            }
            log(report.clickhouse.ok ? `clickhouse ${cfg.url} ${cfg.db}: ${report.clickhouse.tables} statements applied` : `WARNING clickhouse ${cfg.url} not ready: ${report.clickhouse.error}`)
        }
    } finally { db.close() }
    return report
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const json = process.argv.includes('--json')
    try {
        const r = await bootstrap({ log: json ? () => {} : (m) => console.log(`[bootstrap] ${m}`) })
        if (json) console.log(JSON.stringify({ ...r, admin: r.admin && { ...r.admin, password: r.admin.password ? '(generated, see log)' : '' } }))
    } catch (e) { console.error(`[bootstrap] failed: ${e.message}`); process.exit(1) }
}
