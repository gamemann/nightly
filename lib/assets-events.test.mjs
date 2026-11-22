// Run: node --test lib/assets-events.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEventTable, kindOfBehaviour } from './assets-events.mjs'
import { packMatch } from './assets-scan.mjs'

const TABLE = `
const SHOT := &"weapon_shot"
const SWING := &"weapon_swing"
static var _SPEC = {
    SHOT: Spec.Voice.GUN,
    SWING: Spec.Voice.WHOOSH,
}
static func weapon_sound(kind: int) -> StringName:
\tmatch kind:
\t\tKIND_SHOT:
\t\t\treturn SHOT
\t\tKIND_SWING:
\t\t\treturn SWING
`
test('kindOfBehaviour maps behaviour names through a configurable table', () => {
    for (const [b, k] of [['hitscan', 'shot'], ['melee', 'swing'], ['projectile', 'spawn'], ['beam', 'beam'], ['thrown', 'throw'], ['', 'shot']]) assert.equal(kindOfBehaviour(b), k, b)
    assert.equal(kindOfBehaviour('laser', [['laser', 'zap']]), 'zap')
})
test('parseEventTable reads an inline audio table', () => {
    const t = parseEventTable(TABLE)
    assert.deepEqual(Object.keys(t).sort(), ['shot', 'swing'])
    assert.equal(t.shot.event, 'weapon_shot')
    assert.equal(t.shot.voice, 'GUN')
})
test('packMatch finds a pack asset by normalised id', () => {
    const e = [{ rec: { weapon_id: 'zz_ak' } }, { rec: { weapon_id: 'battle_rifle' } }]
    assert.equal(packMatch('battle-rifle', e), e[1])
    assert.equal(packMatch('nothing_like_it', e), null)
})
