import test from 'node:test'
import assert from 'node:assert/strict'
import { parseVmf, parseQuakeMap, brushesToMesh, brushesToVmf, brushesToQuakeMap, meshBrushes, parseObj, sceneToMesh, toMetres, toSource, SOURCE_K } from './map-brush.mjs'
import { detectFormat, makeRegistry, routes, planFor } from './map-convert-formats.mjs'
import { registerBuiltins, mappingReport } from './map-convert.mjs'
registerBuiltins({})

// a 64-unit cube at the origin, as VMF sides (plane points clockwise seen from outside)
const cubeSides = (m) => {
    const f = [
        [[-32, -32, 32], [32, -32, 32], [32, 32, 32]], [[-32, 32, -32], [32, 32, -32], [32, -32, -32]],
        [[-32, -32, 32], [-32, 32, 32], [-32, 32, -32]], [[32, -32, -32], [32, 32, -32], [32, 32, 32]],
        [[-32, 32, 32], [32, 32, 32], [32, 32, -32]], [[32, -32, -32], [32, -32, 32], [-32, -32, 32]],
    ]
    return f.map((p) => `side { "plane" "${p.map((q) => `(${q.join(' ')})`).join(' ')}" "material" "${m}" }`).join('\n')
}
const vmf = `versioninfo { "formatversion" "100" }\nworld { "classname" "worldspawn" solid { "id" "2" ${cubeSides('BRICK/BRICKWALL001')} } }\nentity { "classname" "info_player_terrorist" "origin" "0 0 100" "angles" "0 90 0" }\n`

test('VMF cube becomes a mesh with 6 faces, one hull and a spawn', () => {
    const p = parseVmf(vmf)
    assert.equal(p.brushes.length, 1)
    assert.equal(p.entities.length, 1)
    const m = brushesToMesh(p, { name: 'cube' })
    assert.equal(m.stats.hulls, 1)
    assert.equal(m.stats.polygons, 6)
    assert.equal(m.json.surfaces[0].material, 'brick/brickwall001')
    assert.equal(m.json.surfaces[0].vertex_count, 24)
    assert.equal(m.json.spawns[0].team, 'red')
    assert.ok(Math.abs(m.json.spawns[0].at[1] - 100 * SOURCE_K) < 1e-3)
    assert.equal(m.json.hulls[0].point_count, 8)
})
test('flipped winding still yields a solid', () => {
    const p = parseVmf(vmf)
    for (const pl of p.brushes[0].planes) pl.pts.reverse()
    assert.equal(brushesToMesh(p).stats.hulls, 1)
})
test('Quake map', () => {
    const q = `{\n"classname" "worldspawn"\n{\n${[
        '( -16 -16 16 ) ( 16 -16 16 ) ( 16 16 16 ) sky 0 0 0 1 1', '( -16 16 -16 ) ( 16 16 -16 ) ( 16 -16 -16 ) floor 0 0 0 1 1',
        '( -16 -16 16 ) ( -16 16 16 ) ( -16 16 -16 ) w 0 0 0 1 1', '( 16 -16 -16 ) ( 16 16 -16 ) ( 16 16 16 ) w 0 0 0 1 1',
        '( -16 16 16 ) ( 16 16 16 ) ( 16 16 -16 ) w 0 0 0 1 1', '( 16 -16 -16 ) ( 16 -16 16 ) ( -16 -16 16 ) w 0 0 0 1 1'].join('\n')}\n}\n}\n{\n"classname" "info_player_start"\n"origin" "0 0 24"\n"angle" "90"\n}\n`
    const p = parseQuakeMap(q)
    assert.equal(p.brushes.length, 1)
    const m = brushesToMesh(p, { k: 1 / 32 })
    assert.equal(m.stats.hulls, 1)
    assert.equal(m.json.spawns.length, 1)
})
test('GS mesh -> VMF -> mesh round trip keeps the hull count', () => {
    const m = brushesToMesh(parseVmf(vmf), { name: 'cube' })
    const b = meshBrushes(m.json, m.blob)
    assert.equal(b.length, 1)
    assert.equal(b[0].faces.length, 6)
    const out = brushesToVmf(b, m.json.spawns)
    const again = brushesToMesh(parseVmf(out))
    assert.equal(again.stats.hulls, 1)
    assert.equal(again.stats.polygons, 6)
    assert.match(brushesToQuakeMap(b, m.json.spawns), /info_player_terrorist|info_player_start/)
    assert.equal(parseQuakeMap(brushesToQuakeMap(b, m.json.spawns)).brushes.length, 1)
})
test('axis conversion round trips', () => {
    const p = [10, 20, 30]
    const q = toSource(toMetres(p, 0.5), 0.5)
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(q[i] - p[i]) < 1e-9)
})
test('OBJ scene to map', () => {
    const polys = parseObj('v 0 0 0\nv 1 0 0\nv 1 0 1\nv 0 0 1\nusemtl grass\nf 1 2 3 4\n')
    const m = sceneToMesh(polys, { name: 'quad' })
    assert.equal(m.json.surfaces[0].index_count, 6)
    assert.equal(m.json.spawns.length, 1)
})
test('detectFormat', () => {
    assert.equal(detectFormat('a.bsp', Buffer.from('VBSP')), 'bsp')
    assert.equal(detectFormat('a.vmf', Buffer.from('versioninfo\n{')), 'vmf')
    assert.equal(detectFormat('a.map', Buffer.from('// x\n{\n"classname"')), 'quake-map')
    // No leading comment: the file opens like JSON but is a Quake map (by extension or by content).
    assert.equal(detectFormat('a.map', Buffer.from('{\n"classname" "worldspawn"\n}')), 'quake-map')
    assert.equal(detectFormat('upload.bin', Buffer.from('{\n"classname" "worldspawn"\n}')), 'quake-map')
    assert.equal(detectFormat('a.glb', Buffer.from('glTF')), 'glb')
    assert.equal(detectFormat('a.obj', Buffer.from('v 0 0 0')), 'obj')
    assert.equal(detectFormat('a.json', Buffer.from('{"format":"gs-bsp-mesh"}')), 'gs-map')
    assert.equal(detectFormat('a.json', Buffer.from('{"boxes":[]}')), 'gs-map')
    assert.equal(detectFormat('a.json', Buffer.from('{"asset":{}}')), 'gltf')
    assert.equal(detectFormat('a.zip', Buffer.from('PK')), '')
    assert.equal(detectFormat('noext', Buffer.from('versioninfo {')), 'vmf')
})
test('registry: register, route and plan chaining', () => {
    const r = makeRegistry()
    r.register({ id: 'a', from: 'bsp', to: 'gs-map', label: 'A', run: async () => ({ files: [] }) })
    r.register({ id: 'b', from: 'gs-map', to: 'vmf', label: 'B', run: async () => ({ files: [] }) })
    r.register({ id: 'c', from: 'gs-map', to: 'glb', label: 'C', run: async () => ({ files: [] }), available: () => 'tool missing' })
    assert.throws(() => r.register({ id: 'a', from: 'x', to: 'y', run() {} }), /already/)
    assert.throws(() => r.register({ id: 'z', from: 'x' }), /from, to and run/)
    assert.deepEqual(r.plan('bsp', 'vmf').map((s) => s.id), ['a', 'b'])
    assert.deepEqual(r.plan('bsp', 'bsp'), [])
    assert.equal(r.plan('vmf', 'bsp'), null)
    assert.equal(r.plan('bsp', 'glb'), null, 'unavailable step is not routed')
    assert.deepEqual(r.targets('bsp').sort(), ['gs-map', 'vmf'])
    assert.equal(r.list().find((c) => c.id === 'c').available, 'tool missing')
})
test('default registry covers the feasible formats', () => {
    for (const [f, t] of [['gs-map', 'glb'], ['gs-map', 'vmf'], ['gs-map', 'quake-map'], ['vmf', 'gs-map'], ['quake-map', 'gs-map'], ['obj', 'gs-map'], ['glb', 'gs-map'], ['gs-map', 'bsp']]) {
        assert.ok(planFor(f, t), `${f} -> ${t}`)
    }
    assert.ok(routes().length >= 8)
})
test('the BSP reader route is listed, and reports why it is unavailable without the converter', () => {
    const r = routes().find((c) => c.id === 'bsp-gsmap')
    assert.equal(r.from, 'bsp')
    if (!process.env.GS_MAP_CONVERT_PATH && !process.env.GSBSP_PATH) assert.match(r.available, /not configured/)
})
test('mappingReport splits resolved, generated and unmapped', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const path = await import('node:path')
    const d = mkdtempSync(path.join(tmpdir(), 'mr-'))
    mkdirSync(path.join(d, 'textures'))
    writeFileSync(path.join(d, 'textures', 'stone_wall.png'), 'x')
    writeFileSync(path.join(d, 'm.json'), JSON.stringify({ surfaces: [{ material: 'stone_wall', index_count: 6 }, { material: 'brick/odd_one', index_count: 3 }, { material: 'gen_flat_000000', index_count: 3 }] }))
    const r = mappingReport(path.join(d, 'm.json'), { lookup: (s) => (s === 'odd_one' ? { id: 5, pack: 'p' } : null) })
    assert.deepEqual(r.counts, { resolved: 1, generated: 1, unmapped: 1 })
    assert.equal(r.materials[1].asset.id, 5)
})

test('a gs-map job converts with its .bin: from beside the manifest or from --bin under the name the manifest expects', async () => {
    const fs = await import('node:fs')
    const { mkdtempSync, writeFileSync, rmSync } = fs
    const os = await import('node:os')
    const path = await import('node:path')
    const { DatabaseSync } = await import('node:sqlite')
    const MC = await import('./map-convert.mjs')
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'mc-job-'))
    const prev = process.env.NIGHTLY_MAPCONVERT_DIR
    process.env.NIGHTLY_MAPCONVERT_DIR = path.join(tmp, 'jobs')
    try {
        const db = new DatabaseSync(':memory:')
        const src = path.join(tmp, 'box.map')
        writeFileSync(src, '{\n"classname" "worldspawn"\n{\n( -64 -64 -16 ) ( -64 -63 -16 ) ( -64 -64 -15 ) base 0 0 0 1 1\n( 64 64 16 ) ( 64 64 17 ) ( 64 65 16 ) base 0 0 0 1 1\n( -64 -64 -16 ) ( -64 -64 -15 ) ( -63 -64 -16 ) base 0 0 0 1 1\n( 64 64 16 ) ( 65 64 16 ) ( 64 64 17 ) base 0 0 0 1 1\n( -64 -64 -16 ) ( -63 -64 -16 ) ( -64 -63 -16 ) base 0 0 0 1 1\n( 64 64 16 ) ( 64 65 16 ) ( 65 64 16 ) base 0 0 0 1 1\n}\n}\n')
        const a = MC.createJob(db, { file: src, name: 'box.map', to: 'gs-map' })
        assert.equal((await MC.runJob(db, a)).status, 'done')
        const out = MC.jobOutDir(a)
        // Beside the manifest ("box.bin" sorts before "box.json": the job must still read the manifest).
        const b = MC.createJob(db, { file: path.join(out, 'box.json'), name: 'box.json', to: 'glb' })
        assert.equal((await MC.runJob(db, b)).status, 'done')
        // An upload: the manifest alone in one place, its geometry elsewhere under another name.
        const up = path.join(tmp, 'up'); fs.mkdirSync(up)
        writeFileSync(path.join(up, 'arena.json'), fs.readFileSync(path.join(out, 'box.json')))
        writeFileSync(path.join(tmp, 'upload-123'), fs.readFileSync(path.join(out, 'box.bin')))
        const c = MC.createJob(db, { file: path.join(up, 'arena.json'), name: 'arena.json', to: 'glb', bin: path.join(tmp, 'upload-123') })
        const j = await MC.runJob(db, c)
        assert.equal(j.status, 'done', j.error)
    } finally {
        if (prev === undefined) delete process.env.NIGHTLY_MAPCONVERT_DIR; else process.env.NIGHTLY_MAPCONVERT_DIR = prev
        rmSync(tmp, { recursive: true, force: true })
    }
})
