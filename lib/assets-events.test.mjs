// Run: node --test lib/assets-events.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEventTable, kindOfBehaviour, idCandidates, eventSounds, kindOfName } from './assets-events.mjs'
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

test('idCandidates lists the id, def id, path tail and glb stem once each', () => {
    const c = idCandidates({ weapon_id: 'assets__guns__bullpup', def_id: 'bullpup_rifle', model: { glb: 'models/bullpup.glb' } })
    assert.deepEqual(c, ['assets__guns__bullpup', 'bullpup_rifle', 'bullpup'])
})
test('a game row inherits the sound of the linked pack definition of the same id; an unknown id plays the fallback class', () => {
    const g = { game: 'game-x', file: 'audio.gd', behaviourKinds: [['melee', 'swing']], table: { shot: { event: 'ev_shot' }, swing: { event: 'ev_swing' } },
        fallback: { event: 'class', file: 'zee_weapon_sound.gd' }, defs: new Map([['pack-a', new Map([['sword', 'melee'], ['gun', 'hitscan']])]]) }
    const row = (id, pack = 'game-x') => ({ pack, weapon_id: id, sounds: [] })
    assert.equal(eventSounds(row('sword'), [g])[0].event, 'ev_swing')
    assert.equal(eventSounds(row('gun'), [g])[0].event, 'ev_shot')
    assert.equal(eventSounds(row('frag_grenade'), [g])[0].event, 'class:throw')
    assert.deepEqual(eventSounds(row('frag_grenade', 'other-pack'), [g]), [])
    assert.equal(kindOfName('assets__kit__combat_knife'), 'swing')
    assert.equal(kindOfName('grenade_launcher'), 'shot')
})
