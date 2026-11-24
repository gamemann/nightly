import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { attachSidecar, readSidecar, sidecarOf } from './assets-anim.mjs'

const side = { version: 1, clips: [{ name: 'fire', length: 0.8, frames: 49, loop: false, tracks: [{}, {}] }, { name: 'idle', length: 4, frames: 241, loop: true, tracks: [{}] }] }

test('sidecar sits beside the glb', () => {
    assert.equal(sidecarOf('/a/b.glb'), '/a/b.anim.json')
    assert.equal(sidecarOf(''), '')
})
test('attach replaces the procedural stubs with the baked rows', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'anim-'))
    writeFileSync(path.join(d, 'w.anim.json'), JSON.stringify(side))
    const rec = { animations: [{ name: 'fire', length: null, tracks: 0, flags: ['procedural'] }] }
    const files = { glb: path.join(d, 'w.glb') }
    assert.equal(attachSidecar(rec, files), true)
    assert.deepEqual(rec.animations.map((a) => [a.name, a.length, a.tracks, a.flags.join()]), [['fire', 0.8, 2, 'baked'], ['idle', 4, 1, 'baked,loop']])
    assert.equal(files.anim, path.join(d, 'w.anim.json'))
})
test('no sidecar or a wrong version leaves the record alone', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'anim-'))
    const rec = { animations: [{ name: 'fire' }] }
    assert.equal(attachSidecar(rec, { glb: path.join(d, 'x.glb') }), false)
    writeFileSync(path.join(d, 'y.anim.json'), '{"version":2,"clips":[]}')
    assert.equal(readSidecar(path.join(d, 'y.glb')), null)
    assert.equal(rec.animations.length, 1)
})
test('attach records the sidecar weapon id for sound matching', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'anim-'))
    writeFileSync(path.join(d, 'w.anim.json'), JSON.stringify({ ...side, weapon: 'sniper' }))
    const rec = { weapon_id: 'addons__fc_weapons__assets__models__sniper_ph' }
    attachSidecar(rec, { glb: path.join(d, 'w.glb') })
    assert.equal(rec.anim_weapon, 'sniper')
})
test('a sidecar published to the audit dir is found when the recorded glb path has none beside it', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'anim-')), pub = path.join(d, 'pub'), src = path.join(d, 'src')
    mkdirSync(path.join(pub, 'glb'), { recursive: true }); mkdirSync(src)
    writeFileSync(path.join(pub, 'glb', 'w.anim.json'), JSON.stringify(side))
    const old = process.env.NIGHTLY_ASSETS_DIR
    process.env.NIGHTLY_ASSETS_DIR = pub
    try {
        const files = { glb: path.join(src, 'w.glb') }
        assert.equal(attachSidecar({}, files), true)
        assert.equal(files.anim, path.join(pub, 'glb', 'w.anim.json'))
    } finally { if (old === undefined) delete process.env.NIGHTLY_ASSETS_DIR; else process.env.NIGHTLY_ASSETS_DIR = old }
})
