import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { TAB_SQL, aggCountSql, listCountSql } from './asset-tabs.mjs'
import { AVATAR_KINDS, ENTITY_KINDS } from './asset-names.mjs'

const KINDS = [...ENTITY_KINDS, ...AVATAR_KINDS, 'prop', 'building', 'other', 'map']
function fixture() {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE AssetWeapon (id INTEGER PRIMARY KEY, pack TEXT, weaponId TEXT, kind TEXT, fileHash TEXT, hasModel INT, texCount INT, animCount INT, soundCount INT)')
    const ins = db.prepare('INSERT INTO AssetWeapon (pack, weaponId, kind, fileHash, hasModel, texCount, animCount, soundCount) VALUES (?,?,?,?,?,?,?,?)')
    let i = 0
    for (const kind of KINDS) for (let v = 0; v < 12; v++) {
        // copies in two packs share a hash; some rows have no hash, no model, no texture, animations or sounds
        ins.run(`p${v % 3}`, `${kind}${i++}`, kind, v % 4 === 0 ? 'h' + kind : v % 5 === 0 ? '' : `u${i}`, v % 6 === 5 ? 0 : 1, v % 2, v % 3 === 0 ? 1 : 0, v % 4 === 1 ? 2 : 0)
    }
    return db
}

test('list rows equal tab count and kind chip count for every tab', () => {
    const db = fixture()
    const agg = db.prepare(aggCountSql()).all()
    for (const tab of Object.keys(TAB_SQL)) {
        const total = agg.reduce((a, r) => a + Number(r[tab] ?? 0), 0)
        assert.equal(db.prepare(listCountSql(tab)).get().c, total, `${tab} tab`)
        assert.ok(total > 0, `${tab} has rows in the fixture`)
        for (const r of agg) assert.equal(db.prepare(listCountSql(tab, r.kind)).get().c, Number(r[tab] ?? 0), `${tab} / ${r.kind}`)
    }
})

test('entities, avatars and models are every model row', () => {
    const db = fixture()
    const agg = db.prepare(aggCountSql()).all()
    const sum = (t) => agg.reduce((a, r) => a + Number(r[t] ?? 0), 0)
    const models = db.prepare('SELECT COUNT(*) c FROM (SELECT 1 FROM AssetWeapon WHERE hasModel = 1 GROUP BY CASE WHEN fileHash != \'\' THEN fileHash || kind ELSE id END)').get().c
    assert.equal(sum('entities') + sum('avatars') + sum('models'), models)
})

import { effectiveFilters } from './asset-tabs.mjs'
test('filters that do not belong to the tab are ignored', () => {
    assert.deepEqual(effectiveFilters({ tab: 'entities', grp: 'x', pieces: '1', kind: 'prop', pack: 'p' }), { tab: 'entities', pack: 'p' })
    assert.deepEqual(effectiveFilters({ tab: 'models', kind: 'weapon' }), { tab: 'models' })
    assert.deepEqual(effectiveFilters({ tab: 'models', kind: 'avatar' }), { tab: 'models' })
    assert.deepEqual(effectiveFilters({ tab: 'entities', kind: 'avatar' }), { tab: 'entities' })
    assert.deepEqual(effectiveFilters({ tab: 'avatars', kind: 'avatar' }), { tab: 'avatars', kind: 'avatar' })
    assert.deepEqual(effectiveFilters({ tab: 'models', kind: 'prop' }), { tab: 'models', kind: 'prop' })
    assert.deepEqual(effectiveFilters({ kind: 'weapon' }), { kind: 'weapon' })
    assert.deepEqual(effectiveFilters({ tab: 'maps', grp: 'g', kind: 'prop' }), { tab: 'maps' })
    assert.deepEqual(effectiveFilters({ tab: 'maps', pieces: '1', grp: 'g' }), { tab: 'maps', pieces: '1', grp: 'g' })
    assert.deepEqual(effectiveFilters({ tab: 'textures', grp: 'g', kind: 'prop' }), { tab: 'textures', kind: 'prop' })
})

test('weapon-kit parts (scope, clip, magazine, crate) list on Models, not Entities; weapons and attachments stay put', () => {
    const db = fixture()
    const ins = db.prepare("INSERT INTO AssetWeapon (pack, weaponId, kind, fileHash, hasModel, texCount, animCount, soundCount) VALUES ('g', ?, ?, ?, 1, 0, 0, 0)")
    const rows = [['assets__blaster-kit__blaster-a', 'weapon', true], ['assets__blaster-kit__scope-small', 'weapon', false], ['assets__blaster-kit__clip-large', 'weapon', false],
        ['assets__low-poly-guns__rifle_magazine', 'weapon', false], ['assets__ammo__ammo_shotgun', 'weapon', false], ['assets__low-poly-guns__rifle', 'weapon', true], ['att_scope_6x', 'attachment', null]]
    rows.forEach(([id, kind], i) => ins.run(id, kind, `part${i}`))
    for (const [id, , entity] of rows) {
        const inEnt = db.prepare(`SELECT COUNT(*) c FROM AssetWeapon WHERE weaponId = ? AND ${TAB_SQL.entities}`).get(id).c === 1
        const inMod = db.prepare(`SELECT COUNT(*) c FROM AssetWeapon WHERE weaponId = ? AND ${TAB_SQL.models}`).get(id).c === 1
        if (entity === null) assert.ok(inMod && !inEnt, id)
        else assert.deepEqual([inEnt, inMod], [entity, !entity], id)
    }
})
