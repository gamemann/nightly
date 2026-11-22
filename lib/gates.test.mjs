// Run: node --test lib/gates.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { syncGate, statusForExit, GATE_DOMAINS } from './gates.mjs'
import { memDb } from './testdb.mjs'

const rows = (db) => db.prepare('SELECT domain, subject, code, status, state, nextAction FROM RsiFinding ORDER BY code').all()
test('failing checks open one finding each, a passing rerun closes them', () => {
    const db = memDb()
    const r = syncGate(db, { kind: 'visual', game: 'g1', failures: [{ name: 'map_a', reasons: ['72% changed'] }, { name: 'map_b' }] })
    assert.deepEqual([r.raised, r.closed, r.domain], [2, 0, 'visual'])
    assert.match(rows(db)[0].nextAction, /Re-baseline only if/)
    const again = syncGate(db, { kind: 'visual', game: 'g1', failures: [{ name: 'map_a' }] })
    assert.equal(again.closed, 1)
    assert.deepEqual(rows(db).map((x) => `${x.code}:${x.status}`), ['map_a:open', 'map_b:resolved'])
    syncGate(db, { kind: 'visual', game: 'g1', failures: [] })
    assert.ok(rows(db).every((x) => x.status === 'resolved' && x.state === 'remeasured'))
})
test('findings are per domain and game; infra and non-gate kinds do nothing', () => {
    const db = memDb()
    syncGate(db, { kind: 'netchaos', game: 'g1', failures: [{ name: 'x' }] })
    syncGate(db, { kind: 'perf', game: 'g2', failures: [{ name: 'x' }] })
    syncGate(db, { kind: 'visual', game: 'g1', failures: [] })
    assert.equal(rows(db).filter((x) => x.status === 'open').length, 2)
    assert.equal(syncGate(db, { kind: 'fuzz', game: 'g1', failures: [{ name: 'x' }] }), null)
    assert.equal(syncGate(db, { kind: 'perf', game: 'g2', failures: [], infra: true }), null)
    assert.equal(rows(db).filter((x) => x.status === 'open').length, 2)
    assert.ok(GATE_DOMAINS.netchaos)
})
test('exit codes map to run statuses', () => {
    assert.deepEqual([0, 1, 2, 137].map(statusForExit), ['ok', 'findings', 'failed', 'failed'])
})
