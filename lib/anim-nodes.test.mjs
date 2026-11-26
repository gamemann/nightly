import test from 'node:test'
import assert from 'node:assert/strict'
import { animatedParts, partPose } from './anim-nodes.mjs'

const clip = {
    frames: 2, loop: false,
    tracks: [
        { target: 'magazine', path: 'transform', values: [0, 0, 0, 0, 0, 0, 1, 0, -0.2, 0, 0, 0, 0, 1] },
        { target: 'magazine.visible', path: 'visible', values: [1, 0] },
        { target: 'bolt', path: 'position', values: [0, 0, 0, 0, 0, 0.1] },
    ],
}
test('a magazine transform track gives position, rotation and visibility', () => {
    const p = partPose(clip, 'magazine', 1 / 60, 60)
    assert.deepEqual(p.pos, [0, -0.2, 0])
    assert.deepEqual(p.quat, [0, 0, 0, 1])
    assert.equal(p.visible, false)
    assert.equal(partPose(clip, 'magazine', 0, 60).visible, true)
})
test('a position-only track has no rotation and no visibility', () => {
    const p = partPose(clip, 'bolt', 1 / 60, 60)
    assert.deepEqual(p.pos, [0, 0, 0.1])
    assert.equal(p.quat, null)
    assert.equal(p.visible, null)
})
test('no track means no pose', () => {
    assert.equal(partPose({ frames: 1, loop: false, tracks: [] }, 'magazine', 0, 60), null)
})
test('animatedParts lists the parts any clip moves with their node name', () => {
    const side = { nodes: { bolt: '', magazine: 'mag' }, clips: [clip] }
    assert.deepEqual(animatedParts(side), [{ part: 'bolt', node: '' }, { part: 'magazine', node: 'mag' }])
    assert.deepEqual(animatedParts({ nodes: {}, clips: [{ tracks: [{ target: 'weapon' }] }] }), [])
})
