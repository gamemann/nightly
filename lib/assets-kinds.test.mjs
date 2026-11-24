// Run: node --test lib/assets-kinds.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as AS from './assets.mjs'
import * as K from './assets-kinds.mjs'
import * as S from './assets-sources.mjs'
import { kindFlags } from './assets-checks.mjs'
import { scan } from './assets-scan.mjs'

const fresh = () => { const db = new DatabaseSync(':memory:'); AS.migrate(db); return db }
const rec = (o = {}) => ({ model: { glb: 'a.glb', tris: 5000, materials: 3, bbox: [1, 1, 1], skins: 0, bones: 0, lods: 0, ...o.model }, textures: o.textures ?? [], animations: o.animations ?? [], sounds: [] })
const tex = (px, maps = ['albedo']) => ({ name: 't', w: px, h: px, pot: true, maps })

test('migrate is idempotent and seeds only generic kinds', () => {
    const db = fresh()
    AS.migrate(db)
    const keys = K.list(db).map((k) => k.key)
    assert.ok(keys.includes('avatar') && keys.includes('prop') && keys.includes('other'))
    assert.equal(AS.pending(db), false)
    assert.equal(S.list(db).length, 0, 'no sources are seeded')
})
test('classify: source rules, kind regexes, default', () => {
    const kinds = K.list(fresh())
    assert.equal(K.classify('models/chars/hero_player.glb', { kinds }), 'avatar')
    assert.equal(K.classify('props/crate.glb', { kinds }), 'prop')
    assert.equal(K.classify('x/y.glb', { kinds, rules: [{ match: 'x/', kind: 'vehicle' }] }), 'vehicle')
    assert.equal(K.classify('zzz.glb', { kinds, defaultKind: 'building' }), 'building')
})
test('kinds: save, update, remove refuses a kind in use', () => {
    const db = fresh()
    assert.equal(K.save(db, { key: 'tree', label: 'Trees', match: 'tree', budget: { max_tris: 100 } }), 'added')
    assert.equal(K.save(db, { key: 'tree', budget: { max_tris: 200 } }), 'updated')
    assert.equal(K.list(db).find((k) => k.key === 'tree').budget.max_tris, 200)
    assert.throws(() => K.save(db, { key: 'Bad Key' }), /kind key/)
    assert.throws(() => K.save(db, { key: 'x', match: '(' }), /regex/)
    assert.equal(K.remove(db, 'tree'), 1)
})
test('sources: CRUD, config merge, export has no built-in names', () => {
    const db = fresh()
    const dir = mkdtempSync(path.join(tmpdir(), 'src-'))
    S.add(db, { name: 'my-game', type: 'game', root: dir, config: { models: ['assets/**/*.glb'] } })
    assert.throws(() => S.add(db, { name: 'my-game', root: dir }))
    assert.throws(() => S.add(db, { name: 'bad name', root: dir }), /source name/)
    assert.throws(() => S.set(db, 'my-game', { config: { soundMatch: 'weird' } }), /soundMatch/)
    S.set(db, 'my-game', { config: { exclude: ['build'], models: null } })
    const s = S.get(db, 'my-game')
    assert.deepEqual(s.config, { exclude: ['build'] })
    const cfg = S.exportConfig(db)
    assert.equal(cfg.schema, 'rsi-config/1')
    assert.deepEqual(cfg.sources.map((x) => x.name), ['my-game'])
    assert.deepEqual(cfg.sources[0].models, ['**/*.glb', '**/*.gltf'])
    assert.ok(cfg.kinds.length >= 5)
    S.remove(db, 'my-game')
    assert.equal(S.list(db).length, 0)
})
test('globToRe: ** crosses directories, * does not', () => {
    const m = (g, p) => S.globToRe(g).test(p)
    assert.ok(m('**/*.glb', 'a.glb') && m('**/*.glb', 'a/b/c.glb'))
    assert.ok(m('models/*.glb', 'models/a.glb') && !m('models/*.glb', 'models/x/a.glb'))
    assert.ok(!m('**/*.glb', 'a.png'))
})
test('kindFlags: poly, texture tier, rig, scale, pivot, lods', () => {
    const B = { min_tris: 1000, max_tris: 4000, min_tex: { low: 128, high: 1024 }, require_skin: true, required_clips: ['idle', 'walk'], max_size: 3, require_lods: true }
    const codes = (r, tier = 'high') => kindFlags(r, B, tier).map((f) => f.code)
    const c = codes(rec({ textures: [tex(512)], model: { tris: 5000, bbox: [1, 5, 1] } }))
    for (const x of ['HIGH_TRIS', 'LOW_TEX', 'NO_SKIN', 'MISSING_ANIM_SET', 'SCALE_LARGE', 'NO_LODS']) assert.ok(c.includes(x), x)
    assert.ok(!codes(rec({ textures: [tex(512)] }), 'low').includes('LOW_TEX'), 'tier low accepts 512')
    const ok = codes(rec({ textures: [tex(1024)], model: { tris: 2000, skins: 1, bones: 20, lods: 3 }, animations: [{ name: 'Idle' }, { name: 'walk_fwd' }] }))
    assert.deepEqual(ok, [])
    const piv = kindFlags(rec({ model: { bounds: { min: [4, 2, 4], max: [6, 4, 6] }, bbox: [2, 2, 2] } }), { max_pivot_offset: 0.5 })
    assert.deepEqual(piv.map((f) => f.code), ['PIVOT_OFF'])
    assert.deepEqual(kindFlags({ model: { glb: '' }, textures: [], animations: [], sounds: [] }, B).map((f) => f.code), ['NO_MODEL'])
})
test('ingest accepts assets[] with kinds and the old weapons[]', () => {
    const db = fresh()
    const r = AS.ingestAudit(db, { assets: [{ pack: 'p', weapon_id: 'tree1', kind: 'prop', model: { glb: 'tree1.glb', tris: 10 }, textures: [], animations: [], sounds: [], flags: [] }] })
    assert.equal(r.added, 1)
    AS.ingestAudit(db, { weapons: [{ pack: 'p', weapon_id: 'gun', model: { glb: 'gun.glb', tris: 10 }, textures: [], animations: [], sounds: [], flags: [] }] })
    assert.deepEqual(AS.kindCounts(db).map((k) => [k.kind, k.n]), [['prop', 1], ['weapon', 1]])
    assert.equal(AS.list(db, { kind: 'prop' }).length, 1)
    assert.throws(() => AS.ingestAudit(db, {}), /not an audit file/)
})
test('scanInto without sources fails with the way out', () => {
    assert.throws(() => AS.scanInto(fresh()), /assets source add/)
})
test('scan lists models of a source dir; an unreadable file is logged, not fatal', () => {
    const db = fresh()
    const dir = mkdtempSync(path.join(tmpdir(), 'scan-'))
    mkdirSync(path.join(dir, 'props'))
    writeFileSync(path.join(dir, 'props', 'broken.glb'), 'not a glb')
    S.add(db, { name: 'g', type: 'game', root: dir })
    const logs = []
    const r = AS.scanInto(db, { onLog: (m) => logs.push(m) })
    assert.equal(r.sources, 1)
    assert.ok(logs.some((l) => /unreadable/.test(l)))
})
test('no textures: a flat-colour (palette) model is FLAT_COLOUR info, an unexplained one NO_TEXTURES error', () => {
    const B = { min_tex: { high: 512 } }
    const flat = kindFlags(rec({ model: { flat_colour: true } }), B).find((f) => f.code === 'FLAT_COLOUR')
    assert.equal(flat?.severity, 'info')
    assert.ok(!kindFlags(rec({ model: { flat_colour: true } }), B).some((f) => f.code === 'NO_TEXTURES'))
    const gap = kindFlags(rec(), B).find((f) => f.code === 'NO_TEXTURES')
    assert.equal(gap?.severity, 'error')
})
test('a weapon definition whose model is an audited row (path id) does not become a NO_MODEL row', () => {
    const db = fresh()
    const dir = mkdtempSync(path.join(tmpdir(), 'defs-'))
    mkdirSync(path.join(dir, 'weapons'))
    writeFileSync(path.join(dir, 'weapons', 'uzi.tres'), '[resource]\nid = &"uzi"\n')
    writeFileSync(path.join(dir, 'weapons', 'ghost.tres'), '[resource]\nid = &"ghost"\n')
    S.add(db, { name: 'w', type: 'pack', root: dir, config: { weaponDefs: { glob: 'weapons/*.tres' } } })
    const covered = new Set(['w#assets__kitbash__uzi', 'w|assets/kitbash/uzi.glb'])
    const ctx = { sources: S.list(db), kinds: K.list(db) }
    const ids = scan(ctx, { covered }).map((e) => e.rec.weapon_id)
    assert.deepEqual(ids, ['ghost'])
})
