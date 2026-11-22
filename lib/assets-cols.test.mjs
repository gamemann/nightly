import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shapeOf } from './asset-cols.mjs'
import { thumbFile } from './assets-thumbs.mjs'

test('shapeOf sums textures, animations and sounds from an audit record', () => {
    const s = shapeOf({ model: { verts: 10, materials: 2 }, textures: [{ w: 64, h: 128, bytes: 5, maps: ['a', 'b'] }, { w: 8, h: 8, bytes: 1, maps: ['a'] }], animations: [{ length: 1.5 }], sounds: [{ len: 2, bytes: 9 }] }, { glb: 'x.glb' })
    assert.deepEqual(s, { hasModel: 1, verts: 10, materials: 2, texMax: 128, texBytes: 6, texMaps: 'a,b', animLen: 1.5, soundLen: 2, soundBytes: 9 })
    assert.equal(shapeOf({}).hasModel, 0)
})

test('thumb file names carry the content hash so a changed file gets a new thumbnail', () => {
    assert.notEqual(thumbFile(1, 'model', 'a'.repeat(40)), thumbFile(1, 'model', 'b'.repeat(40)))
    assert.match(thumbFile(7, 'tex', 'c'.repeat(40)), /7-tex-c{12}\.webp$/)
})
