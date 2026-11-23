import test from 'node:test'
import assert from 'node:assert/strict'
import { describe, isMapPiece, PIECE_SQL } from './asset-names.mjs'
import { DatabaseSync } from 'node:sqlite'

test('a map-library prop gets a short name, no legacy prefix', () => {
    const d = describe('game-playground-maps', 'maps__world__.stores__model-library__dotmap__dm_appliancebox__dm_appliancebox')
    assert.equal(d.name, 'Appliancebox')
    assert.equal(d.piece, true)
    assert.doesNotMatch(d.name + d.group, /dotmap|dm_/i)
})
test('a map own model names its map as group, colour code trimmed', () => {
    const d = describe('arena-dm-maps', 'maps__cp-orange-x3__worlds__cp-orange-x3__models__own__own_box_45x20x10_307840__own_box_45x20x10_307840')
    assert.equal(d.name, 'Own box 45x20x10')
    assert.equal(d.group, 'cp-orange-x3')
})
test('generic stems use their folder; plain ids are untouched', () => {
    assert.equal(describe('p', '.stores__model-library__sketchfab__ea1ea4d5847b4550bc58ef4107df6f94__model').name, 'Ea1ea4d5847b4550bc58ef4107df6f94')
    assert.equal(describe('p', 'art-src__base__furniture__sideTableDrawers').name, 'Side Table Drawers')
    assert.equal(describe('p', 'ak47').name, 'Ak47')
    assert.equal(describe('weapons', 'x__models__y').piece, false)
})
test('PIECE_SQL agrees with isMapPiece', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE a (pack TEXT, weaponId TEXT)')
    const rows = [['x-maps', 'model-library__a__b__b'], ['x-maps', 'maps__m__worlds__m__models__own__o__o'], ['x-maps', 'maps__m__m'], ['game', 'model-library__a__b'], ['x-maps', 'modelsXXlibrary']]
    for (const r of rows) db.prepare('INSERT INTO a VALUES (?,?)').run(...r)
    for (const [p, id] of rows) assert.equal(db.prepare(`SELECT ${PIECE_SQL} AS v FROM a WHERE pack=? AND weaponId=?`).get(p, id).v, isMapPiece(p, id) ? 1 : 0, id)
})

test('describe: groupKey is the raw segment a grp filter can match', async () => {
    const { describe } = await import('./asset-names.mjs')
    const d = describe('game-playground-maps', 'maps_world__.stores__model-library__kenney__graveyard-kit__hay-bale-bundled')
    assert.equal(d.groupKey, 'graveyard-kit')
    assert.ok(d.piece)
})
