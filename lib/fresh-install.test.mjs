// Run: node --test lib/fresh-install.test.mjs
// A fresh install with none of this workspace's data: empty DB, no naming or asset-name rules, a foreign project. Every rule
// module must fall back to generic behaviour (nothing assumes our games, packs or repos) and the seeded tables must be generic.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { syncSchema } from './bootstrap.mjs'
import { setRules, loadRules } from './naming-rules.mjs'
import { classify, isGame, OTHER } from './classify.mjs'
import { setNameRules, loadNameRules, describe, isMapPiece, NAME_DEFAULTS } from './asset-names.mjs'
import * as K from './assets-kinds.mjs'
import { kindInTab } from './asset-tabs.mjs'
import * as F from './rsi-flags.mjs'
import { parseCensus } from './rsi-maps.mjs'

const OURS = /\b(fc|zz|zee|playlot|fatal|dot|tmc|airdrift|blaster)[-_]/i

test('fresh install: empty DB loads generic rules and seeds only generic rows', () => {
    const db = new DatabaseSync(':memory:')
    syncSchema(db)          // the full schema, no rows
    loadRules(db)
    loadNameRules(db)
    K.seed(db)
    F.ensure(db)
    const kinds = K.list(db), flags = F.list(db)
    assert.ok(kinds.length && flags.length)
    for (const k of kinds) assert.doesNotMatch(JSON.stringify(k), OURS)
    for (const f of flags) assert.doesNotMatch(`${f.match} ${f.action} ${f.label}`, OURS)
    assert.doesNotMatch(JSON.stringify(NAME_DEFAULTS), OURS)
})

test('foreign project: classify, tabs, names and flags work without our data', () => {
    setRules({})
    setNameRules({})
    assert.equal(isGame('acme-racer'), false)
    assert.equal(classify('acme-racer', 'acme-1', 'Tune the drift'), OTHER)
    // a foreign kind is a plain model; a foreign kind on the entities tab is an entity
    assert.equal(kindInTab('models', 'hovercar', []), true)
    assert.equal(kindInTab('entities', 'hovercar', [{ key: 'hovercar', tab: 'entities' }]), true)
    // names: no workspace prefix is stripped, words are humanized
    assert.equal(describe('acme-pack', 'vehicles__acme_hover_car').name, 'Acme hover car')
    assert.equal(isMapPiece('acme-pack', 'model-library__x'), false)
    // an unknown audit flag still gets a domain and an action
    assert.equal(F.domainOf('ACME_WEIRD'), F.FALLBACK_DOMAIN)
    assert.equal(F.actionOf('ACME_WEIRD'), F.FALLBACK_ACTION)
    // a census log from another game names its own game
    const log = 'inf racer  racer starting\ninf racer map ready map=track1\nmesh census: 5 visible mesh instances\n'
    assert.equal(parseCensus(log).game, 'racer')
})
