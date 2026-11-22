import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import * as L from './agents-live.mjs'
import * as S from './store.mjs'

function memDb() {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE Agent (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'session', task TEXT NOT NULL DEFAULT '', repos TEXT NOT NULL DEFAULT '', runId INTEGER, lastReadId INTEGER NOT NULL DEFAULT 0, startedAt TEXT NOT NULL, lastSeenAt TEXT NOT NULL, endedAt TEXT);
        CREATE TABLE Claim (id INTEGER PRIMARY KEY AUTOINCREMENT, agentId INTEGER NOT NULL, scope TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL, releasedAt TEXT);
        CREATE TABLE Message (id INTEGER PRIMARY KEY AUTOINCREMENT, agentId INTEGER, author TEXT NOT NULL, "to" TEXT, body TEXT NOT NULL, createdAt TEXT NOT NULL);
        CREATE TABLE Setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);`)
    return db
}

test('states: live, stale, left', () => {
    const at = Date.parse('2026-01-02T12:00:00Z')
    const row = (min, ended) => ({ lastSeenAt: new Date(at - min * 60_000).toISOString(), endedAt: ended ? 'x' : null })
    assert.equal(L.stateOf(row(5), { at }), 'live')
    assert.equal(L.stateOf(row(120), { at }), 'stale')
    assert.equal(L.stateOf(row(13 * 60), { at }), 'left')
    assert.equal(L.stateOf(row(1, true), { at }), 'left')
})
test('heartbeat registers, refreshes and the sweep retires silent agents', () => {
    const db = memDb()
    const a = L.heartbeat(db, 'w1', { task: 'x' })
    assert.equal(L.heartbeat(db, 'w1').id, a.id)
    db.prepare('UPDATE Agent SET lastSeenAt = ?').run(new Date(Date.now() - 30 * 3600_000).toISOString())
    assert.deepEqual(L.sweep(db), ['w1'])
    assert.ok(db.prepare('SELECT endedAt FROM Agent').get().endedAt)
})
test('unregistered: configured source minus registered names', () => {
    const db = memDb()
    assert.equal(L.unregistered(db).configured, false)
    L.heartbeat(db, 'known')
    S.setSetting(db, 'agentSourceCmd', `printf 'known fixing a\\nghost doing b\\n'`)
    assert.deepEqual(L.unregistered(db).agents, [{ name: 'ghost', task: 'doing b' }])
    assert.deepEqual(L.parseRunning('[{"name":"a","task":"t"},"b"]').map((x) => x.name), ['a', 'b'])
})
