import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { boxesMesh, worldPackManifest } from './map-defs.mjs'

test('boxesMesh groups by material and tint, 24 vertices per box, spawn becomes an object', () => {
    const r = boxesMesh({ spawn: [1, 2, 3], spawn_yaw: 90, boxes: [
        { at: [0, 0, 0], size: [1, 1, 1], mat: 'concrete' }, { at: [5, 0, 0], size: [2, 1, 1], mat: 'concrete', tint: [1, 0, 0], turn: 45 }, { at: [0, 0, 0], size: [1, 1, 1], material: 'glass' }, { at: 'bad' }] })
    assert.equal(r.json.surfaces.length, 3)
    assert.equal(r.json.surfaces.reduce((n, s) => n + s.vertex_count, 0), 72)
    assert.deepEqual(r.json.spawn, { at: [1, 2, 3], yaw: 90 })
    assert.equal(r.json.surfaces.find((s) => s.material === 'glass').translucent, true)
})
test('boxesMesh is null without boxes', () => assert.equal(boxesMesh({ id: 'x' }), null))
test('worldPackManifest finds the pack beside the definition and rejects path tricks', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mdt-'))
    mkdirSync(path.join(root, 'maps/world/pg_world_a'), { recursive: true })
    writeFileSync(path.join(root, 'maps/world/pg_world_a/pgc_a.json'), '{}')
    const def = path.join(root, 'maps/pgc_a.json')
    assert.equal(worldPackManifest(def, { world: { pack: 'pg_world_a' } }, root), path.join(root, 'maps/world/pg_world_a/pgc_a.json'))
    assert.equal(worldPackManifest(def, { world: { pack: '../x' } }, root), null)
    assert.equal(worldPackManifest(def, { world: { pack: 'nope' } }, root), null)
})
