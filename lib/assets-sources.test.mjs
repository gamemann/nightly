// Run: node --test lib/assets-sources.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { effective } from './assets-sources.mjs'

test('the audit output folder is never scanned, even when a source sets its own exclude list', () => {
    assert.ok(effective({}).exclude.includes('rsi-assets'))
    const e = effective({ exclude: ['.git', 'rsi-assets'] }).exclude
    assert.deepEqual(e, ['.git', 'rsi-assets', 'wt-*'])
    assert.ok(effective({ exclude: ['x'] }).exclude.includes('rsi-assets'))
    assert.ok(effective({ exclude: ['x'] }).exclude.includes('wt-*'))
})
