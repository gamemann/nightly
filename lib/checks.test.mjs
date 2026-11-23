import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as C from './checks.mjs'

function setup() {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'chk-'))
    writeFileSync(path.join(dir, 'chk-demo.sh'), '#!/usr/bin/env bash\n# chk-demo.sh: demo check\necho "FLAG one"; echo "FLAG two"; exit 1\n')
    writeFileSync(path.join(dir, 'chk-fine.sh'), '#!/usr/bin/env bash\n# fine\nexit 0\n')
    return { db: new DatabaseSync(':memory:'), dir }
}

test('scanScripts reads name and description', () => {
    const { dir } = setup()
    assert.deepEqual(C.scanScripts(dir).map((s) => [s.name, s.description]), [['demo', 'demo check'], ['fine', 'fine']])
})

test('save validates; list merges the scan with the configuration', () => {
    const { db, dir } = setup()
    assert.throws(() => C.save(db, { name: 'Bad Name', script: 'chk-demo.sh' }, dir), /name/)
    assert.throws(() => C.save(db, { name: 'x', script: '../etc/passwd' }, dir), /chk-\*/)
    assert.throws(() => C.save(db, { name: 'x', script: 'chk-nope.sh' }, dir), /does not exist/)
    assert.throws(() => C.save(db, { name: 'demo', intervalMin: -1 }, dir), /intervalMin/)
    C.save(db, { name: 'demo', intervalMin: 30 }, dir)
    const l = C.list(db, dir)
    assert.equal(l.find((c) => c.name === 'demo').configured, true)
    assert.equal(l.find((c) => c.name === 'fine').configured, false)
})

test('runScript records exit, flags, output; flagged is not an error', () => {
    const { db, dir } = setup()
    const r = C.runScript(db, 'demo', { dir })
    assert.equal(r.status, 'flagged'); assert.equal(r.flags, 2); assert.match(r.output, /FLAG one/)
    assert.equal(C.runScript(db, 'fine', { dir }).status, 'ok')
    assert.throws(() => C.runScript(db, 'ghost', { dir }), /no check/)
    assert.equal(C.runs(db, { name: 'demo' }).length, 1)
})

test('tickHook runs only scheduled, enabled and overdue checks', () => {
    const { db, dir } = setup()
    C.save(db, { name: 'demo', intervalMin: 60 }, dir)
    C.save(db, { name: 'fine', intervalMin: 0 }, dir)
    const t = Date.now()
    assert.equal(C.tickHook(db, { dir, now: t }).length, 1)
    assert.equal(C.tickHook(db, { dir, now: t + 30 * 60_000 }).length, 0)
    assert.equal(C.tickHook(db, { dir, now: t + 61 * 60_000 }).length, 1)
})
