import test from 'node:test'
import assert from 'node:assert/strict'
import { detectType, safeName, checkMagic, limitBytes, validateUpload, isMapManifest } from './assets-upload-core.mjs'

test('detectType by extension and hint', () => {
    assert.equal(detectType('a.GLB'), 'model')
    assert.equal(detectType('a.fbx'), 'model')
    assert.equal(detectType('t.png'), 'texture')
    assert.equal(detectType('s.ogg'), 'sound')
    assert.equal(detectType('m.bsp'), 'map')
    assert.equal(detectType('m.vmf'), 'map')
    assert.equal(detectType('x.bvh'), 'animation')
    assert.equal(detectType('x.zip'), 'other')
    assert.equal(detectType('x.json', 'map'), 'map')
})
test('safeName strips paths and odd characters', () => {
    assert.equal(safeName('../../up/pass wd.glb'), 'pass_wd.glb')
    assert.equal(safeName('.hidden.png'), 'hidden.png')
    assert.throws(() => safeName(''))
})
test('checkMagic', () => {
    assert.equal(checkMagic('a.glb', Buffer.from('glTF....')), '')
    assert.match(checkMagic('a.glb', Buffer.from('nope')), /glb/)
    assert.equal(checkMagic('a.png', Buffer.from('\x89PNG\r\n', 'latin1')), '')
    assert.match(checkMagic('a.png', Buffer.from('GIF89')), /png/)
    assert.equal(checkMagic('a.bsp', Buffer.from('VBSP\x14\0\0\0', 'latin1')), '')
    assert.match(checkMagic('a.json', Buffer.from('{oops')), /JSON/)
    assert.match(checkMagic('a.png', Buffer.alloc(0)), /empty/)
})
test('limits: 0 and empty mean unlimited, per-type overrides', () => {
    assert.equal(limitBytes({}, 'model'), 0)
    assert.equal(limitBytes({ uploadMaxMb: '0' }, 'model'), 0)
    assert.equal(limitBytes({ uploadMaxMb: '2' }, 'model'), 2 * 1048576)
    assert.equal(limitBytes({ uploadMaxMb: '2', 'uploadMaxMb.sound': '5' }, 'sound'), 5 * 1048576)
    assert.throws(() => limitBytes({ uploadMaxMb: '-1' }, 'model'))
})
test('validateUpload', () => {
    const ok = validateUpload({ name: 'x.glb', bytes: 10, buf: Buffer.from('glTFxxxx') })
    assert.deepEqual(ok, { type: 'model', name: 'x.glb', ext: 'glb' })
    assert.throws(() => validateUpload({ name: 'x.glb', bytes: 3 * 1048576, settings: { uploadMaxMb: 1 } }), /limit/)
    assert.doesNotThrow(() => validateUpload({ name: 'x.glb', bytes: 3 * 1048576, settings: { uploadMaxMb: 0 } }))
    assert.throws(() => validateUpload({ name: 'x.xyz', bytes: 3 }), /unknown file type/)
    assert.equal(validateUpload({ name: 'x.xyz', bytes: 3, hint: 'other' }).type, 'other')
})
test('isMapManifest', () => {
    assert.ok(isMapManifest({ format: 'gs-bsp-mesh' }))
    assert.ok(isMapManifest({ boxes: [] }))
    assert.ok(!isMapManifest({ asset: {} }))
})
