// Run: node --test lib/rsi-flags.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import * as F from './rsi-flags.mjs'
import { syncDoc } from './rsi.mjs'
import { memDb } from './testdb.mjs'

test('seed is generic: no workspace tools, repos or keys', () => {
    const text = JSON.stringify(F.SEED_FLAGS)
    assert.doesNotMatch(text, /tools\/|gs-|fc-|dot-|zee-|texbake|LOOK/)
    for (const f of F.SEED_FLAGS) assert.deepEqual(F.validate(f), [], f.match)
})
test('ensure seeds once; a cleared table stays cleared and falls back to the seed', () => {
    const db = memDb()
    assert.equal(F.list(db).length, F.SEED_FLAGS.length)
    db.exec('DELETE FROM RsiFlag')
    F.ensure(db)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM RsiFlag').get().n, 0)
    assert.equal(F.list(db), F.SEED_FLAGS)
})
test('rows drive domain and next action; a workspace rule wins by sort', () => {
    const db = memDb()
    F.save(db, { match: '^TEXTURE_QUALITY$', action: 'Rebake with the house look', sort: 145 })
    F.save(db, { match: '^WOBBLE$', domain: 'physics', action: 'Fix the collider', sort: 1 })
    db.prepare("INSERT INTO AssetWeapon (pack, weaponId) VALUES ('any-pack','thing')").run()
    syncDoc(db, { thresholds: { tier: 'high' }, assets: [{ pack: 'any-pack', weapon_id: 'thing', score: 50, flags: [{ code: 'TEXTURE_QUALITY', severity: 'warn' }, { code: 'WOBBLE', severity: 'warn' }] }] })
    const rows = Object.fromEntries(db.prepare('SELECT code, domain, nextAction FROM RsiFinding').all().map((r) => [r.code, `${r.domain}|${r.nextAction}`]))
    assert.equal(rows.TEXTURE_QUALITY, 'textures|Rebake with the house look')
    assert.equal(rows.WOBBLE, 'physics|Fix the collider')
})
test('validate rejects a bad regex and a bad domain', () => {
    assert.throws(() => F.save(memDb(), { match: '(' }), /match/)
    assert.throws(() => F.save(memDb(), { match: 'X', domain: 'Bad Domain' }), /domain/)
})
test('works without a Setting table (no marker, seeds when empty)', () => {
    const db = new DatabaseSync(':memory:')
    F.ensure(db); F.ensure(db)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM RsiFlag').get().n, F.SEED_FLAGS.length)
})
