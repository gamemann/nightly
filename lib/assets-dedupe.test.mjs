import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dedupeSources } from './assets-scan.mjs'

test('a symlinked alias source is dropped, the first one wins', () => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'dedupe-'))
    mkdirSync(path.join(d, 'real')); mkdirSync(path.join(d, 'other'))
    symlinkSync(path.join(d, 'real'), path.join(d, 'alias'))
    const logs = []
    const out = dedupeSources([{ name: 'a', root: path.join(d, 'real') }, { name: 'b', root: path.join(d, 'alias') }, { name: 'c', root: path.join(d, 'other') }, { name: 'd', root: path.join(d, 'missing') }], (m) => logs.push(m))
    assert.deepEqual(out.map((s) => s.name), ['a', 'c', 'd'])
    assert.equal(logs.length, 1); assert.match(logs[0], /skip b/)
})
