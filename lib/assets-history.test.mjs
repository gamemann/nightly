// Run: node --test lib/assets-history.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import * as AS from './assets.mjs'
import * as S from './assets-sources.mjs'

test('each audit ingest appends one trend row per pack; AssetWeapon keeps only the latest', () => {
    const db = new DatabaseSync(':memory:')
    AS.migrate(db)
    assert.deepEqual(AS.history(db), [])
    S.add(db, { name: 'p', root: '/nonexistent', type: 'pack' })
    const doc = (score) => ({ assets: [{ pack: 'p', weapon_id: 'a', kind: 'weapon', flags: [], score, pass: score >= 70, model: { glb: 'a.glb' } }, { pack: 'p', weapon_id: 'b', kind: 'weapon', flags: [], score: 30, pass: false, model: { glb: 'b.glb' } }] })
    AS.ingestAudit(db, doc(90), { auditDir: '/nonexistent' })
    AS.ingestAudit(db, doc(50), { auditDir: '/nonexistent' })
    const h = AS.history(db, { pack: 'p' })
    assert.equal(h.length, 2)
    assert.deepEqual(h.map((r) => [r.total, r.pass, r.avgScore]), [[2, 1, 60], [2, 0, 40]])
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM AssetWeapon').get().n, 2)
})
