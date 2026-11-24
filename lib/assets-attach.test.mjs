// Run: node --test lib/assets-attach.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import * as AS from './assets.mjs'

const doc = (extra = {}) => ({
    assets: [
        { pack: 'p', weapon_id: 'addons__x__models__rifle', kind: 'weapon', flags: [], model: {} },
        { pack: 'p', weapon_id: 'addons__x__models__pistol', kind: 'weapon', flags: [], model: {} },
        { pack: 'p', weapon_id: 'att_scope', kind: 'attachment', flags: [], model: {} },
    ],
    attach_links: [
        { pack: 'p', parent: 'rifle', attachment: 'att_scope', slot: 'optic', pos: [0, 0.1, -0.2], meta: { excludes: ['sidearm'] } },
        { pack: 'p', parent: 'pistol', attachment: 'att_scope', slot: 'optic', pos: [0, 0.05, -0.1], rot: [0, 90, 0], scale: [2, 2, 2] },
        { pack: 'p', parent: 'ghost', attachment: 'att_scope', slot: 'optic', pos: [0, 0, 0] },
    ],
    ...extra,
})
const idOf = (db, w) => db.prepare('SELECT id FROM AssetWeapon WHERE weaponId = ?').get(w).id

test('migrate is idempotent and creates the link table and the attachment kind', () => {
    const db = new DatabaseSync(':memory:')
    AS.migrate(db); AS.migrate(db)
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='AssetAttachment'").get())
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM AssetKind WHERE key='attachment'").get().n, 1)
})

test('ingest stores attachments as assets and links them to the weapons they fit, by model key', () => {
    const db = new DatabaseSync(':memory:')
    AS.migrate(db)
    const r = AS.ingestAudit(db, doc(), { auditDir: '/nonexistent' })
    assert.equal(r.links.links, 2)
    assert.deepEqual(r.links.unresolved, ['ghost'])
    const scope = idOf(db, 'att_scope'), rifle = idOf(db, 'addons__x__models__rifle'), pistol = idOf(db, 'addons__x__models__pistol')
    assert.equal(db.prepare('SELECT kind FROM AssetWeapon WHERE id = ?').get(scope).kind, 'attachment')
    const a = AS.attachmentsOf(db, rifle)
    assert.equal(a.attachments.length, 1)
    assert.deepEqual([a.attachments[0].slot, a.attachments[0].px, a.attachments[0].py, a.attachments[0].pz], ['optic', 0, 0.1, -0.2])
    assert.deepEqual(a.attachments[0].meta, { excludes: ['sidearm'] })
    const p = AS.attachmentsOf(db, pistol).attachments[0]
    assert.deepEqual([p.ry, p.sx], [90, 2])
    assert.deepEqual(AS.attachmentsOf(db, scope).fits.map((f) => f.name).sort(), ['addons__x__models__pistol', 'addons__x__models__rifle'])
})

test('re-ingest replaces the links of an attachment instead of duplicating them', () => {
    const db = new DatabaseSync(':memory:')
    AS.migrate(db)
    AS.ingestAudit(db, doc(), { auditDir: '/nonexistent' })
    AS.ingestAudit(db, doc(), { auditDir: '/nonexistent' })
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM AssetAttachment').get().n, 2)
    const d = doc(); d.attach_links.splice(1, 2)
    AS.ingestAudit(db, d, { auditDir: '/nonexistent' })
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM AssetAttachment').get().n, 1)
})

test('an install from before attachments gets the table on its first link, and deleting a weapon drops its links', () => {
    const db = new DatabaseSync(':memory:')
    AS.migrate(db)
    db.exec('DROP TABLE AssetAttachment')
    AS.ingestAudit(db, doc(), { auditDir: '/nonexistent' })
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM AssetAttachment').get().n, 2)
    db.prepare('DELETE FROM AssetWeapon WHERE weaponId = ?').run('addons__x__models__rifle')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM AssetAttachment').get().n, 1)
})
