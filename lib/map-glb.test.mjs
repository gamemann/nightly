import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { boxTriangles, chunkSurface, hullTriangles, manifestLayout, mapFindings, mapToGlb } from './map-glb.mjs'
import { readModel, stats } from './glb.mjs'

// A two-quad tier-layout map: 8 vertices * 40 bytes, 12 indices, one cube hull, a spawn and a zone.
function fixture() {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mapglb-'))
    const verts = new Float32Array(8 * 10)
    const quad = (o, x) => { [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([a, b], i) => { verts.set([x + a * 100, 0, b * 100, 0, 1, 0, a, b, 0, 0], (o + i) * 10) }) }
    quad(0, 0); quad(4, 5000)
    const idx = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7])
    const cube = []
    for (const x of [0, 1]) for (const y of [0, 1]) for (const z of [0, 1]) cube.push(x * 100, y * 100, z * 100)
    const hull = Buffer.alloc(4 + 8 * 12); hull.writeUInt32LE(8, 0); Buffer.from(new Float32Array(cube).buffer).copy(hull, 4)
    const bin = Buffer.concat([Buffer.from(verts.buffer), Buffer.from(idx.buffer), hull])
    writeFileSync(path.join(dir, 'm.bin'), bin)
    writeFileSync(path.join(dir, 'm.json'), JSON.stringify({
        units: 'x metres = x * 0.01905', surfaces: [{ material: 'a/b', vertex_offset: 0, vertex_count: 8, index_offset: 320, index_count: 12, colour: [1, 0, 0] }],
        collision: { hull_offset: 368, hull_count: 1 }, spawns: [{ origin: [50, 0, 50], yaw: 90 }], zones: [{ kind: 'Start', min: [0, 0, 0], max: [100, 100, 100] }],
    }))
    return path.join(dir, 'm.json')
}

test('layout detection', () => {
    assert.equal(manifestLayout({ format: 'dot-bsp-mesh', surfaces: [] }), 'mesh')
    assert.equal(manifestLayout({ format: 'gs-bsp-mesh', surfaces: [] }), 'mesh')
    assert.equal(manifestLayout({ surfaces: [{ vertex_offset: 0 }] }), 'tier')
    assert.equal(manifestLayout({ id: 'licence' }), '')
})
test('tier map converts to a loadable GLB with overlays and findings', () => {
    const f = fixture()
    const r = mapToGlb(f, { chunk: 10 })
    assert.equal(r.layout, 'tier')
    assert.equal(r.stats.tris, 4); assert.equal(r.stats.chunks, 2); assert.equal(r.stats.spawns, 1); assert.equal(r.stats.hulls, 1); assert.equal(r.stats.triggers, 1)
    assert.equal(r.stats.untextured, 1); assert.deepEqual(r.stats.missingTextures, ['a/b'])
    const out = path.join(path.dirname(f), 'o.glb'); writeFileSync(out, r.glb)
    const m = readModel(out)
    const names = m.json.nodes.map((n) => n.name)
    assert.ok(names.includes('collision_solid') && names.includes('trigger_start') && names.includes('entity_spawns'))
    assert.equal(m.json.scenes[0].extras.map.spawns.length, 1)
    assert.ok(stats(m).tris >= 4)
    const ed = m.json.scenes[0].extras.map.editor
    assert.equal(ed.materials[0].name, 'a/b'); assert.equal(ed.triggers.length, 1); assert.equal(ed.hulls.length, 1); assert.equal(ed.hullKinds.solid, 1)
    const nx = (n) => m.json.nodes.find((x) => x.name === n).extras
    assert.equal(nx('collision_solid').class, 'hull'); assert.equal(nx('trigger_start').class, 'trigger'); assert.equal(nx('entity_spawns').count, 1)
    assert.ok(m.json.nodes.filter((x) => x.name?.startsWith('world_')).every((x) => x.extras.class === 'brush' && x.extras.material === 'a/b'))
    assert.ok(Math.abs(r.stats.bounds.max[0] - 5100 * 0.01905) < 0.01)
    assert.equal(mapToGlb(f, { overlays: false }).glb.length < r.glb.length, true)
})
test('non-map JSON is null', () => {
    const f = fixture(); writeFileSync(f, '{"id":"x"}')
    assert.equal(mapToGlb(f), null)
})
test('hull faces: cube from points gives 12 triangles', () => {
    const p = []; for (const x of [0, 1]) for (const y of [0, 1]) for (const z of [0, 1]) p.push([x, y, z])
    assert.equal(hullTriangles(p).length / 9, 12)
    assert.equal(boxTriangles([0, 0, 0], [1, 1, 1]).length / 9, 12)
})
test('chunking splits by cell and keeps triangles', () => {
    const s = { pos: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 100, 0, 0, 101, 0, 0, 100, 1, 0]), nor: new Float32Array(18), uv: new Float32Array(12), idx: new Uint32Array([0, 1, 2, 3, 4, 5]) }
    assert.equal(chunkSurface(s, 10).length, 2); assert.equal(chunkSurface(s, 0).length, 1)
})
test('findings follow the budget', () => {
    const st = { tris: 100, untexturedTris: 100, untextured: 3, missingTextures: ['a'], spawns: 0, hulls: 0 }
    assert.deepEqual(mapFindings(st, {}).map((f) => f.code), [])
    assert.deepEqual(mapFindings(st, { max_untextured_pct: 50, require_spawns: true, require_collision: true }).map((f) => f.code), ['MAP_UNTEXTURED', 'MAP_NO_SPAWNS', 'MAP_NO_COLLISION'])
    assert.deepEqual(mapFindings({ tris: 0, hulls: 5 }).map((f) => f.code), ['MAP_HULLS_ONLY'])
})
