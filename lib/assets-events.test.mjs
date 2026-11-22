// Run: node --test lib/assets-events.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseEventTable, kindOfBehaviour, packMatch } from './assets.mjs'

const zz = '/home/gamedev/godot/game-zombie-zone/game/zz_audio.gd'
test('kindOfBehaviour maps behaviour scripts to weapon-use kinds', () => {
    for (const [b, k] of [['dot_weapon_hitscan', 'shot'], ['dot_weapon_melee', 'swing'], ['dot_weapon_zz_shield', 'swing'], ['dot_weapon_projectile', 'spawn'], ['dot_weapon_beam', 'beam'], ['dot_weapon_thrown', 'throw'], ['', 'shot']])
        assert.equal(kindOfBehaviour(b), k, b)
})
test('parseEventTable reads the Zombie Zone table (skipped without the checkout)', { skip: !process.env.CI && !readFileOk() }, () => {
    const t = parseEventTable(readFileSync(zz, 'utf8'))
    assert.deepEqual(Object.keys(t).sort(), ['beam', 'shot', 'spawn', 'swing', 'throw'])
    assert.equal(t.shot.event, 'weapon_shot')
    assert.equal(t.shot.voice, 'SHOT')
})
function readFileOk() { try { readFileSync(zz); return true } catch { return false } }
test('packMatch finds a pack gun by normalised id', () => {
    const e = [{ rec: { weapon_id: 'zz_ak' } }, { rec: { weapon_id: 'battle_rifle' } }]
    assert.equal(packMatch('battle-rifle', e), e[1])
    assert.equal(packMatch('nothing_like_it', e), null)
})
