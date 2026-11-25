// Run: node --test lib/asset-coverage.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as AS from './assets.mjs'
import * as K from './assets-kinds.mjs'
import * as S from './assets-sources.mjs'
import { aggregate, linkIcons, coverageOf, emptySources, licenceOf, needsOf, refresh, sourceIndex, stemsOf, text } from './asset-coverage.mjs'

const fresh = () => { const db = new DatabaseSync(':memory:'); AS.migrate(db); return db }
const ALL = ['model', 'texture', 'sound', 'anim', 'icon', 'licence']
const yes = () => true
const idxOf = (o = {}) => ({ enabled: true, root: '/r', rootOk: true, icons: new Set(), rules: [], entries: [], ...o })
const row = (o = {}) => ({ weaponId: 'w', hasModel: 1, texCount: 1, ...o })

test('needsOf: an explicit needs list wins, else it follows the budget', () => {
    assert.deepEqual(needsOf({ needs: ['model', 'icon', 'bogus'] }), ['model', 'icon'])
    assert.deepEqual(needsOf({}), ['model', 'licence'])
    assert.deepEqual(needsOf({ min_tex: 512, require_sounds: true, required_clips: ['fire'] }), ['model', 'licence', 'texture', 'sound', 'anim'])
})

test('licenceOf: rules first, then the longest licence-file prefix', () => {
    const entries = [{ paths: [''], licence: 'MIT' }, { paths: ['models/'], licence: 'CC-BY-4.0' }, { paths: ['models/kenney'], licence: 'CC0-1.0' }]
    assert.equal(licenceOf('models/kenney/a.glb', { entries }), 'CC0-1.0')
    assert.equal(licenceOf('models/x.glb', { entries }), 'CC-BY-4.0')
    assert.equal(licenceOf('other/x.glb', { entries }), 'MIT')
    assert.equal(licenceOf('models/kenneyish/x.glb', { entries }), 'CC-BY-4.0', 'a prefix matches whole path segments')
    assert.equal(licenceOf('models/x.glb', { rules: [{ match: '^models/', licence: 'OWN' }], entries }), 'OWN')
    assert.equal(licenceOf('', { entries }), '')
})

test('coverageOf: ok, na and the gaps of a kind', () => {
    const c = coverageOf(row(), { model: { glb: 'a.glb' }, _files: { glb: '/r/a.glb' } }, { needs: ['model', 'texture', 'licence'], idx: idxOf({ rules: [{ match: '.', licence: 'MIT' }] }), exists: yes })
    assert.deepEqual(c.s, { model: 'ok', texture: 'ok', sound: 'na', anim: 'na', icon: 'na', licence: 'ok' })
    assert.deepEqual(c.g, [])
    assert.equal(c.l, 'MIT')
    assert.equal(c.o, '')
})

test('coverageOf: stale model, placeholders, stale sound events, icons by stem, "none stated" licence', () => {
    const data = {
        model: { glb: 'weapons/axe.glb' }, _files: { glb: '/gone/axe.glb' }, flags: [{ code: 'FLAT_COLOUR' }],
        sounds: [{ event: 'zee_weapon_sound.class_for:shot' }], animations: [{ name: 'idle', flags: ['static'] }],
    }
    const idx = idxOf({ icons: new Set(['axe']), entries: [{ paths: [''], licence: 'none stated' }] })
    const c = coverageOf(row({ texCount: 0 }), data, { needs: ALL, idx, exists: (p) => !p.startsWith('/gone') })
    assert.deepEqual(c.s, { model: 'stale', texture: 'placeholder', sound: 'stale', anim: 'placeholder', icon: 'ok', licence: 'missing' })
    assert.deepEqual(c.g, ['model', 'texture', 'sound', 'anim', 'licence'])
    const synth = coverageOf(row(), { model: { glb: 'x.glb' }, sounds: [{ synth: 'beep' }], flags: [{ code: 'PRIMITIVE_MESH' }] }, { needs: ALL, idx: idxOf(), exists: yes })
    assert.equal(synth.s.sound, 'placeholder')
    const prim = coverageOf(row({ texCount: 0 }), { model: { glb: 'x.glb' }, flags: [{ code: 'PRIMITIVE_MESH' }] }, { needs: ALL, idx: idxOf(), exists: yes })
    assert.equal(prim.s.texture, 'placeholder', 'a vertex-coloured primitive is a stand-in, not nothing')
    const rootGone = coverageOf(row(), { model: { glb: 'moved.glb' } }, { needs: ALL, idx: idxOf(), exists: (p) => p !== '/r/moved.glb' })
    assert.equal(rootGone.s.model, 'stale', 'the model is gone from the source root')
    assert.deepEqual(stemsOf({ weaponId: 'pack__Battle_Rifle' }, { model: { glb: 'a/b/axe-2.glb' } }).sort(), ['axe2', 'battlerifle'])
})

test('coverageOf: orphan reasons', () => {
    const o = (idx) => coverageOf(row(), {}, { needs: ['model'], idx, exists: yes }).o
    assert.equal(o(undefined), 'no-source')
    assert.equal(o(idxOf({ enabled: false })), 'disabled')
    assert.equal(o(idxOf({ rootOk: false })), 'root-missing')
})

test('aggregate counts per pack and kind', () => {
    const cov = (g, s = {}) => ({ s: { model: 'ok', texture: 'ok', sound: 'na', anim: 'na', icon: 'na', licence: 'ok', ...s }, o: '', g })
    const m = aggregate([
        { pack: 'p', kind: 'prop', coverage: JSON.stringify(cov([])) },
        { pack: 'p', kind: 'prop', coverage: cov(['texture'], { texture: 'missing' }) },
        { pack: 'p', kind: 'weapon', coverage: { ...cov(['icon'], { icon: 'missing' }), o: 'disabled' } },
        { pack: 'q', kind: 'prop', coverage: '' },
    ])
    assert.equal(m.totals.rows, 3)
    assert.equal(m.totals.complete, 1)
    assert.equal(m.totals.orphan, 1)
    assert.equal(m.totals.dims.texture.missing, 1)
    assert.deepEqual(m.packs.map((p) => p.pack), ['p'], 'rows not computed yet are skipped')
    const p = m.packs[0]
    assert.equal(p.orphan, 'disabled')
    assert.deepEqual(p.kinds.map((k) => [k.kind, k.rows, k.complete, k.gaps.texture, k.gaps.icon]), [['prop', 2, 1, 1, 0], ['weapon', 1, 0, 0, 1]])
    assert.match(text(m, [{ name: 'empty', enabled: true, rootOk: false }]), /sources with no rows: empty \(root missing\)/)
})

test('source config: icons globs, licenceRules and licenceFile are validated', () => {
    assert.doesNotThrow(() => S.validateConfig({ icons: ['icons/*.png'], licenceRules: [{ match: '^a/', licence: 'MIT' }], licenceFile: 'LICENCES.json' }))
    assert.throws(() => S.validateConfig({ icons: 'icons/*.png' }), /icons/)
    assert.throws(() => S.validateConfig({ licenceRules: [{ match: '(', licence: 'MIT' }] }), /bad regex/)
    assert.throws(() => S.validateConfig({ licenceRules: [{ match: 'a' }] }), /needs a licence/)
    assert.throws(() => S.validateConfig({ licenceFile: 3 }), /licenceFile/)
})

test('refresh + reclassify on a real source: kind rules move existing rows, icons and licence come from the root', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cov-'))
    mkdirSync(path.join(root, 'icons')); mkdirSync(path.join(root, 'model-library'))
    writeFileSync(path.join(root, 'icons', 'axe.svg'), '<svg/>')
    writeFileSync(path.join(root, 'axe.glb'), 'x'); writeFileSync(path.join(root, 'model-library', 'crate.glb'), 'x')
    writeFileSync(path.join(root, 'licence.json'), JSON.stringify([{ paths: [''], licence: 'MIT' }]))
    const db = fresh()
    S.add(db, { name: 'p', root, config: { icons: ['icons/*.svg'], kindRules: [{ match: '(^|/)model-library/', kind: 'prop' }] } })
    K.save(db, { key: 'weapon', budget: { needs: ['model', 'icon', 'licence'] } })
    const ins = db.prepare("INSERT INTO AssetWeapon (pack, weaponId, kind, hasModel, texCount, data) VALUES ('p', ?, ?, 1, 1, ?)")
    ins.run('p__axe', 'weapon', JSON.stringify({ model: { glb: 'axe.glb' } }))
    ins.run('p__crate', 'weapon', JSON.stringify({ model: { glb: 'model-library/crate.glb' } }))
    ins.run('p__gone', 'weapon', JSON.stringify({ model: { glb: 'gone.glb' } }))
    assert.equal(AS.reclassify(db), 1)
    assert.equal(db.prepare("SELECT kind FROM AssetWeapon WHERE weaponId = 'p__crate'").get().kind, 'prop')
    const m = refresh(db)
    assert.equal(m.totals.rows, 3)
    const cov = Object.fromEntries(db.prepare('SELECT weaponId, coverage FROM AssetWeapon').all().map((r) => [r.weaponId, JSON.parse(r.coverage)]))
    assert.deepEqual(cov.p__axe.g, [])
    assert.equal(cov.p__axe.l, 'MIT')
    assert.equal(cov.p__gone.s.model, 'stale')
    assert.deepEqual(cov.p__gone.g, ['model', 'icon'])
    assert.equal(cov.p__crate.s.icon, 'na', 'a prop does not need an icon')
    assert.ok(sourceIndex(S.get(db, 'p')).icons.has('axe'))
    S.add(db, { name: 'empty', root: path.join(root, 'nope') })
    assert.deepEqual(emptySources(db), [{ name: 'empty', enabled: true, rootOk: false }])
})

test('iconSources: a source reuses the icon stems of the packs it names', () => {
    const idx = new Map([
        ['pack', { icons: new Set(['axe']), iconSources: [] }],
        ['game', { icons: new Set(['own']), iconSources: ['pack', 'missing'] }],
    ])
    linkIcons(idx)
    assert.deepEqual([...idx.get('game').icons].sort(), ['axe', 'own'])
    assert.deepEqual([...idx.get('pack').icons], ['axe'])
})
