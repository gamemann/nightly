import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { setRules, loadRules } from './naming-rules.mjs'
import { classify, gameFromText } from './classify.mjs'
import { makeResolver } from './project-map.mjs'

const P = [{ slug: 'game-alpha', type: 'game', settings: '{}' }, { slug: 'gs-core', type: 'game-addon', settings: '{}' }]

test('with no rules only the generic naming applies', () => {
    setRules({})
    assert.equal(gameFromText('x-1', 'Alpha zombie work'), '')
    assert.equal(classify('gs-core', 'k', 't', new Set()), 'other')
    const r = makeResolver(P)
    assert.equal(r.resolveToken('game-alpha-7').slug, 'game-alpha')
    assert.equal(r.resolveToken('dot-core'), null)
    assert.equal(r.resolveToken('old-alpha'), null)
})

test('rules from data add renames, rewrites, keywords and areas', () => {
    setRules({ renames: { 'old-alpha': 'game-alpha' }, rewrites: [['^dot-', 'gs-']], gameKeywords: [['alph', 'game-alpha']], dev: '^gs-' })
    const r = makeResolver(P)
    assert.equal(r.resolveToken('old-alpha').slug, 'game-alpha')
    assert.equal(r.resolveToken('dot-core').slug, 'gs-core')
    assert.equal(gameFromText('x', 'Alphabet'), 'game-alpha')
    assert.equal(classify('gs-core', 'k', 't', new Set()), 'dev')
    setRules({})
})

test('loadRules reads the namingRules setting and ignores a missing table', () => {
    const db = new DatabaseSync(':memory:')
    loadRules(db)
    db.exec('CREATE TABLE Setting (key TEXT PRIMARY KEY, value TEXT)')
    db.prepare("INSERT INTO Setting VALUES ('namingRules', ?)").run(JSON.stringify({ games: ['game-alpha'] }))
    loadRules(db)
    assert.equal(classify('game-alpha', '', '', new Set()), 'game-alpha')
    assert.throws(() => setRules('[1]'))
    setRules({})
})
