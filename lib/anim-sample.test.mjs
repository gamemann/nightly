import test from 'node:test'
import assert from 'node:assert/strict'
import { frameAt, lens, moveShare, sample, verticalFrom43 } from './anim-sample.mjs'

const L = { reference_depth: 0.55, max_pull_in: 0.1, depth_comp: 1 }
const close = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} vs ${b}`)

test('frameAt wraps loops and clamps one-shots', () => {
    assert.deepEqual(frameAt(0.5, 60, 60, false), { a: 30, b: 31, k: 0 })
    assert.equal(frameAt(99, 60, 60, false).a, 59)
    const w = frameAt(61 / 60 + 0.5 / 60, 60, 60, true)
    assert.equal(w.a, 1)
    close(w.k, 0.5)
    assert.equal(frameAt(59.5 / 60, 60, 60, true).b, 0)
})
test('positions lerp, visibility steps, transforms slerp', () => {
    const pos = { path: 'position', values: [0, 0, 0, 2, 4, 6] }
    assert.deepEqual(sample(pos, 0.5 / 60, 2, 60, false), [1, 2, 3])
    assert.deepEqual(sample({ path: 'visible', values: [0, 1] }, 0.5 / 60, 2, 60, false), [0])
    const s = Math.SQRT1_2
    const tr = { path: 'transform', values: [0, 0, 0, 0, 0, 0, 1, 2, 0, 0, 0, 0, s, s] }
    const m = sample(tr, 0.5 / 60, 2, 60, false)
    close(m[0], 1)
    close(m[5], Math.sin(Math.PI / 8))
    close(m[6], Math.cos(Math.PI / 8))
})
test('the lens matches the game: 54 on a 4:3 hands fov inside a 90 world fov', () => {
    close(verticalFrom43(90), 2 * Math.atan(0.75) * 180 / Math.PI)
    const l = lens(L, verticalFrom43(90), verticalFrom43(54))
    close(l.k, Math.tan(verticalFrom43(90) * Math.PI / 360) / Math.tan(verticalFrom43(54) * Math.PI / 360))
    assert.ok(l.k > 1 && l.z < 0)
    assert.deepEqual(lens(L, 70, 0), { k: 1, z: 0 })
    close(lens(L, 50, 100).z, 0.1)
})

test('lens_move_share matches AwViewModelState: 1 at the reference lens, below 1 for a narrow hands fov drawn near', () => {
    const L = { reference_fov: 90, reference_depth: 0.55, max_pull_in: 0.1, depth_comp: 1 }
    assert.equal(moveShare(L, 90), 1)
    assert.equal(moveShare(L, 0), 1)
    const size = Math.tan(Math.PI / 4) / Math.tan((60 * Math.PI) / 360)
    close(moveShare(L, 60), (0.55 + Math.min(Math.max((size - 1) * 0.55, -0.1), 1e9)) / (0.55 * size))
    assert.ok(moveShare({ ...L, depth_comp: 0 }, 60) < 1)
})
