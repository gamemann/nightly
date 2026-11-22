// Run: node --test lib/rsi.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { domainOf, nextActionFor, syncDoc, queueFixItems, board, setting, SETTINGS } from './rsi.mjs'
import { memDb } from './testdb.mjs'

test('domainOf routes flags to board domains', () => {
    const t = { LOW_TEX: 'textures', LOSSY_TEX: 'textures', NO_NORMAL: 'textures', NO_MODEL: 'weapons', LOW_TRIS: 'weapons', MAG_STATIC: 'animations', NO_SOUNDS: 'sounds' }
    for (const [c, d] of Object.entries(t)) assert.equal(domainOf(c), d, c)
})
test('nextActionFor: specific text per flag, generic fallback', () => {
    assert.match(nextActionFor('LOW_TRIS'), /triangle/)
    assert.match(nextActionFor('FLAT_TEX'), /albedo/)
    assert.match(nextActionFor('SOMETHING_NEW'), /re-run the audit/)
})
test('settings default and override', () => {
    const db = memDb()
    assert.equal(setting(db, 'rsiMeshBudget'), SETTINGS.rsiMeshBudget)
    db.prepare("INSERT INTO Setting (key, value) VALUES ('rsiMeshBudget','900')").run()
    assert.equal(setting(db, 'rsiMeshBudget'), 900)
    assert.equal(setting(db, 'rsiAuditDir'), '')
})

const doc = (flags, score = 60) => ({ thresholds: { tier: 'high' }, weapons: [{ pack: 'fc-weapons', weapon_id: 'ak', score, flags }] })
test('syncDoc: raise, update, close (remeasured with score), reopen', () => {
    const db = memDb()
    db.prepare("INSERT INTO AssetWeapon (pack, weaponId) VALUES ('fc-weapons','ak')").run()
    assert.equal(syncDoc(db, doc([{ code: 'LOW_TRIS', severity: 'warn', msg: 'm' }, { code: 'LOW_TEX', severity: 'error', msg: 'm' }])).added, 2)
    assert.equal(syncDoc(db, doc([{ code: 'LOW_TRIS', severity: 'warn', msg: 'm' }, { code: 'LOW_TEX', severity: 'error', msg: 'm' }])).updated, 2)
    const r = syncDoc(db, doc([{ code: 'LOW_TRIS', severity: 'warn', msg: 'm' }], 90))
    assert.equal(r.closed, 1)
    const tex = db.prepare("SELECT status, state, beforeScore, afterScore, tier FROM RsiFinding WHERE code='LOW_TEX'").get()
    assert.deepEqual({ ...tex }, { status: 'resolved', state: 'remeasured', beforeScore: 60, afterScore: 90, tier: 'high' })
    assert.equal(syncDoc(db, doc([{ code: 'LOW_TEX', severity: 'error', msg: 'm' }, { code: 'LOW_TRIS', severity: 'warn', msg: 'm' }])).reopened, 1)
})
test('syncDoc: non-primary tier only judges texture flags', () => {
    const db = memDb()
    syncDoc(db, doc([{ code: 'LOW_TRIS', severity: 'warn', msg: '' }, { code: 'LOW_TEX', severity: 'warn', msg: '' }]), { tier: 'low', primary: false })
    assert.deepEqual(db.prepare('SELECT code, tier FROM RsiFinding').all().map((x) => ({ ...x })), [{ code: 'LOW_TEX', tier: 'low' }])
})
test('board counts per domain; queueFixItems skips process and maps findings', () => {
    const db = memDb()
    syncDoc(db, doc([{ code: 'LOW_TRIS', severity: 'warn', msg: '' }]))
    db.prepare("INSERT INTO RsiFinding (domain, subject, code, severity, msg, nextAction, firstSeenAt, lastSeenAt) VALUES ('maps','playlot/pgc_x','MESH_OVER_BUDGET','warn','m','n','t','t')").run()
    assert.deepEqual(board(db).map((r) => `${r.domain}:${r.open}`), ['maps:1', 'weapons:1'])
    assert.equal(db.prepare("SELECT COUNT(*) n FROM RsiFinding WHERE domain NOT IN ('process','maps') AND status='open'").get().n, 1)
})
