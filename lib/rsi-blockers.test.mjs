// Run: node --test lib/rsi-blockers.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OWNER_WAIT, PROD_DEPLOY, detect, syncBlockers } from './rsi-blockers.mjs'
import { memDb, addItem } from './testdb.mjs'
import { OWNER } from './owner.mjs'

test('OWNER_WAIT matches owner waits', () => {
    for (const s of ['waiting on the owner', 'Waiting for christian to answer', 'owner approval needed', 'owner to decide', 'needs the owner', 'need owner input'])
        assert.ok(OWNER_WAIT.test(s), s)
})
test('OWNER_WAIT ignores unrelated text', () => {
    for (const s of ['waiting on CI', 'the owner of the file is core', 'ownership transfer', 'waiting for a box'])
        assert.ok(!OWNER_WAIT.test(s), s)
})
test('PROD_DEPLOY matches the prod website deploy only', () => {
    for (const s of ['prod website deploy', 'production deploy', 'OWNER DEPLOY', 'owner deploy']) assert.ok(PROD_DEPLOY.test(s), s)
    assert.ok(!PROD_DEPLOY.test('dev deploy'))
})

const at = Date.parse('2026-11-22T12:00:00Z')
const it = (o) => ({ id: 1, key: 'k', title: `title ${o.key ?? 'k'}`, status: 'queue', kind: 'task', addedBy: 'agent', updatedAt: '2026-11-21T00:00:00Z', body: '', lastNote: '', ...o })

test('detect: duplicates close the later non-owner item, keep owner items', () => {
    const r = detect([it({ id: 1, key: 'a', title: 'Fix the Gun!' }), it({ id: 2, key: 'b', title: 'fix the gun' }), it({ id: 3, key: 'c', title: 'Fix  the gun', addedBy: OWNER })], { at })
    assert.deepEqual(r.map((x) => [x.subject, x.code, !!x.close]), [['b', 'DUPLICATE', true], ['c', 'DUPLICATE', false]])
})
test('detect: stale only when old, not in progress; owner items are not auto-closed', () => {
    const old = '2026-09-01T00:00:00Z'
    const r = detect([it({ id: 1, key: 'a', updatedAt: old }), it({ id: 2, key: 'b', updatedAt: old, status: 'in_progress' }), it({ id: 3, key: 'c', updatedAt: old, addedBy: OWNER }), it({ id: 4, key: 'd' })], { at })
    assert.deepEqual(r.map((x) => [x.subject, x.code, !!x.close]), [['a', 'STALE', true], ['c', 'STALE', false]])
    assert.deepEqual(detect([it({ updatedAt: old })], { at, staleDays: 0 }), [])
})
test('detect: owner wait is an error, prod deploy wait and plain blocked are not', () => {
    const r = detect([it({ id: 1, key: 'a', lastNote: 'waiting on the owner' }), it({ id: 5, key: 'r', lastNote: 'waiting on the owner', lastNoteBy: OWNER }), it({ id: 2, key: 'b', lastNote: 'needs owner for the prod website deploy' }), it({ id: 3, key: 'c', status: 'blocked', lastNote: 'box down' }), it({ id: 4, key: 'x', kind: 'check', body: 'needs owner' })], { at })
    assert.deepEqual(r.map((x) => [x.subject, x.code, x.severity]), [['a', 'OWNER_WAIT', 'error'], ['b', 'BLOCKED', 'warn'], ['c', 'BLOCKED', 'warn']])
})

test('syncBlockers: closes stale agent items, writes process findings, resolves them when cleared', () => {
    const db = memDb()
    addItem(db, { key: 'old', updatedAt: '2026-09-01T00:00:00Z' })
    addItem(db, { key: 'wait', body: 'x' }); db.prepare("INSERT INTO Note (itemId, author, body) SELECT id, 'agent', 'waiting for christian' FROM Item WHERE key='wait'").run()
    const r = syncBlockers(db, { at })
    assert.equal(r.closed, 1)
    assert.equal(db.prepare("SELECT status FROM Item WHERE key='old'").get().status, 'wontfix')
    const f = db.prepare("SELECT subject, code, status FROM RsiFinding WHERE domain='process' ORDER BY subject").all()
    assert.deepEqual(f.map((x) => `${x.subject}:${x.code}:${x.status}`), ['old:STALE:resolved', 'wait:OWNER_WAIT:open'])
    db.prepare("DELETE FROM Note WHERE itemId=(SELECT id FROM Item WHERE key='wait')").run()
    syncBlockers(db, { at })
    assert.equal(db.prepare("SELECT status FROM RsiFinding WHERE subject='wait'").get().status, 'resolved')
})
