import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { bootstrap, syncSchema, parseSchemaColumns, envDbConnections, SCHEMA, BASELINE } from './bootstrap.mjs'

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'nb-test-'))
const quiet = { NIGHTLY_ADMIN_USER: 'root1', NIGHTLY_ADMIN_PASSWORD: 'pw-for-test-1' }

test('baseline.sql covers every model in schema.prisma', () => {
    const models = Object.keys(parseSchemaColumns(readFileSync(SCHEMA, 'utf8')))
    const sql = readFileSync(BASELINE, 'utf8')
    for (const m of models) assert.match(sql, new RegExp(`CREATE TABLE "${m}"`), `${m} missing: run npm run db:baseline`)
})

test('an empty database gets every table, roles and the admin', async () => {
    const dir = tmp(), file = path.join(dir, 'sub', 'n.db')
    const r = await bootstrap({ dbFile: file, env: { ...quiet } })
    assert.ok(r.schema.created.length > 30)
    assert.deepEqual(r.schema.skipped, [])
    assert.equal(r.admin.username, 'root1')
    const db = new DatabaseSync(file)
    for (const t of ['Item', 'User', 'Role', 'Node', 'NodeJob', 'BuildConfig', 'DbConnection', 'usage_message']) assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(t), t)
    assert.ok(db.prepare("SELECT 1 FROM User WHERE username = 'root1'").get())
    assert.ok(db.prepare("SELECT 1 FROM Role WHERE name = 'admin'").get())
    db.close()
})

test('a second run changes nothing', async () => {
    const file = path.join(tmp(), 'n.db')
    await bootstrap({ dbFile: file, env: { ...quiet } })
    const r = await bootstrap({ dbFile: file, env: { ...quiet } })
    assert.deepEqual(r.schema.created, [])
    assert.deepEqual(r.schema.added, [])
    assert.equal(r.admin, null)
})

test('a table from an older schema gains the new columns', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE "Node" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "name" TEXT NOT NULL)')
    db.exec("INSERT INTO Node (name) VALUES ('old')")
    const r = syncSchema(db)
    assert.ok(r.added.includes('Node.conn'))
    assert.ok(r.added.includes('Node.port'))
    assert.equal(db.prepare('SELECT port, conn FROM Node').get().port, 4001)
    assert.equal(db.prepare('SELECT conn FROM Node').get().conn, '{}')
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'NodeJob'").get())
})

test('clickhouse: the database and tables are created when configured, a dead server is a warning', async () => {
    const calls = []
    const fetchImpl = async (url, init) => { calls.push(String(init?.body ?? url)); return new Response('', { status: 200 }) }
    const env = { ...quiet, NIGHTLY_CLICKHOUSE_URL: 'http://ch.test:8123', NIGHTLY_CLICKHOUSE_DB: 'dbx', NIGHTLY_CLICKHOUSE_USER: 'u', NIGHTLY_CLICKHOUSE_PASSWORD: 'p' }
    const r = await bootstrap({ dbFile: path.join(tmp(), 'n.db'), env, fetchImpl })
    assert.ok(r.clickhouse.ok)
    assert.ok(calls.some((c) => /CREATE DATABASE/i.test(c)))
    assert.deepEqual(r.connections, ['clickhouse'])
    const dead = await bootstrap({ dbFile: path.join(tmp(), 'm.db'), env, chWaitSec: 0, fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
    assert.equal(dead.clickhouse.ok, false)
    assert.match(dead.clickhouse.error, /ECONNREFUSED/)
})

test('env connection never carries the password', () => {
    const [c] = envDbConnections({ NIGHTLY_CLICKHOUSE_URL: 'http://h:9000', NIGHTLY_CLICKHOUSE_PASSWORD: 'topsecret' })
    assert.equal(c.port, 9000)
    assert.ok(!JSON.stringify(c).includes('topsecret'))
})
