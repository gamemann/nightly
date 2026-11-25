import test from 'node:test'
import assert from 'node:assert/strict'
import { advance, clipPlayable, defaultClip } from './anim-play.mjs'

test('clipPlayable rejects zero, negative and non-numbers', () => {
    assert.equal(clipPlayable(0.5), true)
    for (const v of [0, -1, null, undefined, NaN, Infinity]) assert.equal(clipPlayable(v), false)
})
test('defaultClip prefers idle, then first playable', () => {
    assert.equal(defaultClip([{ name: 'attack', length: 1 }, { name: 'Idle_01', length: 2 }]), 'Idle_01')
    assert.equal(defaultClip([{ name: 'a', length: 0 }, { name: 'b', length: 1 }]), 'b')
    assert.equal(defaultClip([{ name: 'a', length: 0 }]), '')
    assert.equal(defaultClip([]), '')
})
test('advance wraps when looping and stops otherwise', () => {
    assert.ok(Math.abs(advance(0.9, 0.2, 1, 1, true).t - 0.1) < 1e-9)
    assert.deepEqual(advance(0.9, 0.2, 1, 1, false), { t: 1, ended: true })
    assert.ok(Math.abs(advance(0.5, 0.2, 2, 2, false).t - 0.9) < 1e-9)
    assert.deepEqual(advance(0.1, 0.5, 1, 0, true), { t: 0, ended: false })
    assert.ok(Math.abs(advance(0.1, 0.2, -1, 1, true).t - 0.9) < 1e-9)
})
