import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { TAB_SQL, aggCountSql, listCountSql } from './asset-tabs.mjs'

// Tabs come from AssetKind.tab rows, not code: this fixture is the workspace mapping
const TABS = { weapon: 'entities', grenade: 'entities', pickup: 'entities', vehicle: 'entities', viewmodel: 'entities', avatar: 'avatars', npc: 'avatars', monster: 'avatars', character: 'avatars', level: 'maps', prop: '', building: '', other: '', map: '' }
const KIND_ROWS = Object.entries(TABS).map(([key, tab]) => ({ key, tab }))
const KINDS = Object.keys(TABS).filter((k) => k !== 'level')
function fixture() {
    const db = new DatabaseSync(':memory:')
    db.exec("CREATE TABLE AssetKind (key TEXT PRIMARY KEY, tab TEXT NOT NULL DEFAULT '')")
    for (const k of KIND_ROWS) db.prepare('INSERT INTO AssetKind (key, tab) VALUES (?, ?)').run(k.key, k.tab)
    db.exec('CREATE TABLE AssetWeapon (id INTEGER PRIMARY KEY, pack TEXT, weaponId TEXT, kind TEXT, fileHash TEXT, hasModel INT, texCount INT, animCount INT, soundCount INT, vendoredFrom TEXT NOT NULL DEFAULT \'\')')
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
    assert.deepEqual(effectiveFilters({ tab: 'entities', grp: 'x', pieces: '1', kind: 'prop', pack: 'p' }, KIND_ROWS), { tab: 'entities', pack: 'p' })
    assert.deepEqual(effectiveFilters({ tab: 'models', kind: 'weapon' }, KIND_ROWS), { tab: 'models' })
    assert.deepEqual(effectiveFilters({ tab: 'models', kind: 'avatar' }, KIND_ROWS), { tab: 'models' })
    assert.deepEqual(effectiveFilters({ tab: 'entities', kind: 'avatar' }, KIND_ROWS), { tab: 'entities' })
    assert.deepEqual(effectiveFilters({ tab: 'avatars', kind: 'avatar' }, KIND_ROWS), { tab: 'avatars', kind: 'avatar' })
    assert.deepEqual(effectiveFilters({ tab: 'models', kind: 'prop' }, KIND_ROWS), { tab: 'models', kind: 'prop' })
    assert.deepEqual(effectiveFilters({ kind: 'weapon' }, KIND_ROWS), { kind: 'weapon' })
    assert.deepEqual(effectiveFilters({ tab: 'maps', grp: 'g', kind: 'prop' }, KIND_ROWS), { tab: 'maps' })
    assert.deepEqual(effectiveFilters({ tab: 'maps', pieces: '1', grp: 'g' }, KIND_ROWS), { tab: 'maps', pieces: '1', grp: 'g' })
    assert.deepEqual(effectiveFilters({ tab: 'textures', grp: 'g', kind: 'prop' }, KIND_ROWS), { tab: 'textures', kind: 'prop' })
})

test('tabs follow the AssetKind rows: a foreign kind on a tab moves, an unknown kind is a plain model', () => {
    const db = fixture()
    db.exec("INSERT INTO AssetKind (key, tab) VALUES ('starship', 'entities')")
    db.exec("UPDATE AssetKind SET tab = '' WHERE key = 'vehicle'")
    const ins = db.prepare("INSERT INTO AssetWeapon (pack, weaponId, kind, fileHash, hasModel, texCount, animCount, soundCount) VALUES ('f', ?, ?, ?, 1, 0, 0, 0)")
    ins.run('ship1', 'starship', 's1'); ins.run('car1', 'vehicle', 'c1'); ins.run('blob1', 'unlisted', 'b1')
    const on = (id, tab) => db.prepare(`SELECT COUNT(*) c FROM AssetWeapon WHERE weaponId = ? AND ${TAB_SQL[tab]}`).get(id).c === 1
    assert.ok(on('ship1', 'entities') && !on('ship1', 'models'))
    assert.ok(on('car1', 'models') && !on('car1', 'entities'))
    assert.ok(on('blob1', 'models') && !on('blob1', 'entities') && !on('blob1', 'avatars'))
    const rows = [...KIND_ROWS, { key: 'starship', tab: 'entities' }]
    assert.deepEqual(effectiveFilters({ tab: 'entities', kind: 'starship' }, rows), { tab: 'entities', kind: 'starship' })
    assert.deepEqual(effectiveFilters({ tab: 'models', kind: 'unlisted' }, rows), { tab: 'models', kind: 'unlisted' })
})

test('weapon-kit parts (scope, clip, magazine, crate) list on Models, not Entities; weapons and attachments stay put', () => {
    const db = fixture()
    const ins = db.prepare("INSERT INTO AssetWeapon (pack, weaponId, kind, fileHash, hasModel, texCount, animCount, soundCount) VALUES ('g', ?, ?, ?, 1, 0, 0, 0)")
    const rows = [['assets__toy-kit__blaster-a', 'weapon', true], ['assets__toy-kit__scope-small', 'weapon', false], ['assets__toy-kit__clip-large', 'weapon', false],
        ['assets__low-poly-guns__rifle_magazine', 'weapon', false], ['assets__ammo__ammo_shotgun', 'weapon', false], ['assets__low-poly-guns__rifle', 'weapon', true], ['att_scope_6x', 'attachment', null]]
    rows.forEach(([id, kind], i) => ins.run(id, kind, `part${i}`))
    for (const [id, , entity] of rows) {
        const inEnt = db.prepare(`SELECT COUNT(*) c FROM AssetWeapon WHERE weaponId = ? AND ${TAB_SQL.entities}`).get(id).c === 1
        const inMod = db.prepare(`SELECT COUNT(*) c FROM AssetWeapon WHERE weaponId = ? AND ${TAB_SQL.models}`).get(id).c === 1
        if (entity === null) assert.ok(inMod && !inEnt, id)
        else assert.deepEqual([inEnt, inMod], [entity, !entity], id)
    }
})
