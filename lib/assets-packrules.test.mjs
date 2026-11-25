// Run: node --test lib/assets-packrules.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { judgePackRules, syncPackRules, vendoredSubjects } from './assets-packrules.mjs'
import { validateConfig } from './assets-sources.mjs'
import { syncDoc } from './rsi.mjs'
import { memDb } from './testdb.mjs'
import { ensureColumns } from './asset-cols.mjs'

const SOURCES = [
    { name: 'gun-pack', type: 'pack', config: {} },
    { name: 'other-guns', type: 'pack', config: {} },
    { name: 'map-pack', type: 'pack', config: {} },
    { name: 'game-a', type: 'game', config: { allowedPacks: ['gun-pack'], eventTable: { linkedSources: ['gun-pack', 'other-guns'] } } },
    { name: 'game-b', type: 'game', config: { allowedPacks: ['other-guns'], forbidPaths: ['(^|/)junk/'] } },
    { name: 'game-c', type: 'game', config: {} },
]
const ROWS = [
    { id: 1, pack: 'gun-pack', weaponId: 'pistol', fileHash: 'h1', path: 'guns/pistol.glb' },
    { id: 2, pack: 'other-guns', weaponId: 'rifle', fileHash: 'h2', path: 'guns/rifle.glb' },
    { id: 3, pack: 'map-pack', weaponId: 'crate', fileHash: 'h3', path: 'props/crate.glb' },
    { id: 4, pack: 'gun-pack', weaponId: 'old', fileHash: 'h4', path: 'blaster-kit/old.glb' },
    { id: 10, pack: 'game-a', weaponId: 'pistol', fileHash: 'h1', path: 'assets/guns/pistol.glb' },     // allowed copy
    { id: 11, pack: 'game-a', weaponId: 'rifle', fileHash: 'h2', path: 'assets/guns/rifle.glb' },      // governed, not allowed
    { id: 12, pack: 'game-a', weaponId: 'crate', fileHash: 'h3', path: 'assets/crate.glb' },           // ungoverned map pack: attributed
    { id: 13, pack: 'game-a', weaponId: 'own', fileHash: 'h9', path: 'assets/own.glb' },               // its own asset
    { id: 14, pack: 'game-b', weaponId: 'junk', fileHash: 'h8', path: 'assets/junk/thing.glb' },       // source forbidPaths
    { id: 15, pack: 'game-c', weaponId: 'pistol', fileHash: 'h1', path: 'p.glb' },                     // no allowedPacks: no limit
    { id: 16, pack: 'game-c', weaponId: 'rifle', fileHash: 'h2', path: 'r.glb' },
]

test('judgePackRules: copies of allowed or ungoverned packs are vendored, governed others are violations', () => {
    const { vendored, violations } = judgePackRules(SOURCES, ROWS, { forbid: ['(^|/)blaster-kit/'] })
    assert.deepEqual([...vendored.entries()].sort((a, b) => a[0] - b[0]), [[10, 'gun-pack/pistol'], [12, 'map-pack/crate'], [15, 'gun-pack/pistol'], [16, 'other-guns/rifle']])
    const got = violations.map((v) => `${v.code} ${v.subject}`).sort()
    assert.deepEqual(got, [
        'FORBIDDEN_PATH game-b/junk',
        'FORBIDDEN_PATH gun-pack/old',
        'PACK_NOT_ALLOWED game-a/linkedSources/other-guns',
        'PACK_NOT_ALLOWED game-a/rifle',
    ])
    assert.match(violations.find((v) => v.subject === 'game-a/rifle').msg, /other-guns not in game-a's allowedPacks \(gun-pack\)/)
})

test('judgePackRules: an allowed pack wins over a lower-id pack that holds the same file', () => {
    const rows = [{ id: 1, pack: 'other-guns', weaponId: 'x', fileHash: 'h', path: '' }, { id: 2, pack: 'gun-pack', weaponId: 'x', fileHash: 'h', path: '' },
        { id: 3, pack: 'game-a', weaponId: 'x', fileHash: 'h', path: '' }]
    const { vendored, violations } = judgePackRules(SOURCES, rows)
    assert.equal(vendored.get(3), 'gun-pack/x')
    assert.equal(violations.filter((v) => v.subject === 'game-a/x').length, 0)
})

test('validateConfig: allowedPacks and forbidPaths are lists, forbidPaths must compile', () => {
    assert.ok(validateConfig({ allowedPacks: ['a'], forbidPaths: ['^x/'] }))
    assert.throws(() => validateConfig({ allowedPacks: 'a' }), /allowedPacks must be a list/)
    assert.throws(() => validateConfig({ forbidPaths: ['('] }), /forbidPaths: bad regex/)
})

function seed() {
    const db = memDb()
    db.exec(`CREATE TABLE AssetSource (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'pack', root TEXT NOT NULL DEFAULT '',
        repo TEXT NOT NULL DEFAULT '', enabled BOOLEAN NOT NULL DEFAULT true, config TEXT NOT NULL DEFAULT '{}', lastScanAt TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL DEFAULT '', updatedAt TEXT NOT NULL DEFAULT '')`)
    for (const c of ["data TEXT NOT NULL DEFAULT '{}'", "kind TEXT NOT NULL DEFAULT ''", 'score INTEGER NOT NULL DEFAULT 0', 'tris INTEGER NOT NULL DEFAULT 0']) db.exec(`ALTER TABLE AssetWeapon ADD COLUMN ${c}`)
    ensureColumns(db)                                              // fileHash, vendoredFrom and the rest, as the panel has them
    for (const s of SOURCES) db.prepare('INSERT INTO AssetSource (name, type, config) VALUES (?,?,?)').run(s.name, s.type, JSON.stringify(s.config))
    for (const r of ROWS) db.prepare('INSERT INTO AssetWeapon (id, pack, weaponId, fileHash, data) VALUES (?,?,?,?,?)').run(r.id, r.pack, r.weaponId, r.fileHash, JSON.stringify({ _files: { glb: r.path } }))
    return db
}
const open = (db) => db.prepare("SELECT subject, code FROM RsiFinding WHERE status = 'open' ORDER BY subject, code").all().map((r) => `${r.code} ${r.subject}`)

test('syncPackRules: marks vendored rows, raises once, closes when fixed, resolves audit findings on copies', () => {
    const db = seed()
    const doc = { thresholds: { tier: 'high' }, weapons: [{ pack: 'gun-pack', weapon_id: 'pistol', score: 50, flags: [{ code: 'LOW_TRIS', severity: 'warn' }] },
        { pack: 'game-a', weapon_id: 'pistol', score: 50, flags: [{ code: 'LOW_TRIS', severity: 'warn' }] }]}
    syncDoc(db, doc)                                              // before the rule: the copy got its own finding
    assert.ok(open(db).includes('LOW_TRIS game-a/pistol'))
    const r = syncPackRules(db, { forbid: ['(^|/)blaster-kit/'] })
    assert.deepEqual(r, { vendored: 4, raised: 4, closed: 0, hidden: 1 })
    assert.equal(db.prepare('SELECT vendoredFrom FROM AssetWeapon WHERE id = 10').get().vendoredFrom, 'gun-pack/pistol')
    assert.ok(vendoredSubjects(db).has('game-a/pistol'))
    assert.ok(!open(db).includes('LOW_TRIS game-a/pistol'), 'the copy is judged on the pack row')
    assert.ok(open(db).includes('LOW_TRIS gun-pack/pistol'))
    syncDoc(db, doc)                                              // the audit still lists the copy: syncDoc skips it
    assert.ok(!open(db).includes('LOW_TRIS game-a/pistol'))
    assert.equal(syncPackRules(db, { forbid: ['(^|/)blaster-kit/'] }).raised, 4, 'idempotent: same findings, updated')
    assert.equal(db.prepare("SELECT COUNT(*) c FROM RsiFinding WHERE code IN ('PACK_NOT_ALLOWED','FORBIDDEN_PATH')").get().c, 4)
    db.prepare('DELETE FROM AssetWeapon WHERE id IN (4, 11)').run()  // the files were removed
    db.prepare('UPDATE AssetSource SET config = ? WHERE name = ?').run(JSON.stringify({ allowedPacks: ['gun-pack'], eventTable: { linkedSources: ['gun-pack'] } }), 'game-a')
    const r2 = syncPackRules(db, { forbid: ['(^|/)blaster-kit/'] })
    assert.equal(r2.closed, 3)
    assert.deepEqual(open(db).filter((s) => /PACK_NOT_ALLOWED|FORBIDDEN_PATH/.test(s)), ['FORBIDDEN_PATH game-b/junk'])
})
