import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findCompanion, hashColour, materialIndex, modelFor, proxyBox } from './map-textures.mjs'
import { mapToGlb, worldUv } from './map-glb.mjs'
import { readModel } from './glb.mjs'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

function world() {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'maptex-'))
    const verts = new Float32Array(4 * 10)
    ;[[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([a, b], i) => verts.set([a * 100, 0, b * 100, 0, 1, 0, a, b, 0, 0], i * 10))
    writeFileSync(path.join(dir, 'm.bin'), Buffer.concat([Buffer.from(verts.buffer), Buffer.from(new Uint32Array([0, 1, 2, 0, 2, 3]).buffer)]))
    writeFileSync(path.join(dir, 'm.json'), JSON.stringify({ surfaces: [
        { material: 'a/b', vertex_offset: 0, vertex_count: 4, index_offset: 160, index_count: 6 },
        { material: 'a/unmapped', vertex_offset: 0, vertex_count: 4, index_offset: 160, index_count: 6 },
    ] }))
    mkdirSync(path.join(dir, 'worlds/m/textures'), { recursive: true })
    writeFileSync(path.join(dir, 'worlds/m/textures/fb_x.png'), PNG)
    writeFileSync(path.join(dir, 'worlds/m/m.json'), JSON.stringify({
        format: 'dot-bsp-mesh', surfaces: [{ material: 'a/b', free: 'pbr:x' }, { material: 'a/unmapped' }],
        licence: { textures: [{ key: 'pbr:x', file: 'pbr/x', fallback_file: 'textures/fb_x.png' }] },
        props: [{ at: [1, 0, 1], yaw: 0, scale: 1, stand_in: 'nomodel', size: 1 }],
    }))
    return dir
}

test('hashColour is stable and in range', () => {
    assert.deepEqual(hashColour('a/b'), hashColour('a/b'))
    assert.notDeepEqual(hashColour('a/b'), hashColour('a/c'))
    for (const c of hashColour('zz')) assert.ok(c >= 0 && c <= 1)
})
test('findCompanion honours templates and rejects non-mesh manifests', () => {
    const d = world()
    assert.ok(findCompanion(path.join(d, 'm.json'), ['worlds/{stem}/{stem}.json']))
    assert.equal(findCompanion(path.join(d, 'm.json'), ['nope/{stem}.json']), null)
    assert.equal(findCompanion(path.join(d, 'm.json'), ['m.json']), null)
})
test('materialIndex falls back to the pack image; modelFor misses cleanly; proxyBox sizes', () => {
    const d = world()
    const comp = findCompanion(path.join(d, 'm.json'), ['worlds/{stem}/{stem}.json'])
    const idx = materialIndex(comp, {})
    assert.ok(idx.get('a/b').albedo.endsWith('fb_x.png'))
    assert.equal(idx.has('a/unmapped'), false)
    assert.equal(modelFor('nomodel', comp, {}), null)
    assert.deepEqual(proxyBox({ bounds: { box: [2, 3, 4] } }), [2, 3, 4])
    assert.deepEqual(proxyBox({ size: 2 }), [2, 1, 1])
})
test('worldUv tiles by world position on the dominant axis', () => {
    const uv = new Float32Array(4)
    worldUv([0, 0, 0, 2, 0, 0], [0, 1, 0, 0, 1, 0], uv, 0.5)
    assert.equal(uv[2] - uv[0], 1)
})
test('map with a companion embeds textures, a hash colour for the unmapped, and a labelled box for a missing prop', () => {
    const d = world()
    const r = mapToGlb(path.join(d, 'm.json'), { companions: ['worlds/{stem}/{stem}.json'], cacheDir: path.join(d, 'cache'), texMax: 64 })
    assert.equal(r.stats.mappedMaterials, 1); assert.equal(r.stats.untextured, 1)
    assert.deepEqual(r.stats.missingTextures, ['a/unmapped'])
    assert.equal(r.stats.propsMissing, 1); assert.deepEqual(r.stats.missingModels, ['nomodel'])
    assert.ok(r.findings.some((f) => f.code === 'MAP_MODEL_MISSING'))
    const f = path.join(d, 'o.glb'); writeFileSync(f, r.glb)
    const j = readModel(f).json
    assert.ok(j.nodes.some((n) => /^missing_nomodel/.test(n.name) && n.extras?.label))
    assert.ok(j.materials.some((m) => m.pbrMetallicRoughness?.baseColorTexture))
})
