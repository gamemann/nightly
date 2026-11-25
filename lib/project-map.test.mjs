import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { syncSchema } from './bootstrap.mjs'
import { makeResolver, mapProjects, planMapping, countSqls, countsPerProject, needsMapping, syncItem, tokensOf } from './project-map.mjs'
import { addItem, updateItem } from './store.mjs'
import { readFileSync } from 'node:fs'
import { setRules } from './naming-rules.mjs'
import { seed as seedKinds } from './assets-kinds.mjs'
setRules(readFileSync(new URL('./naming-rules.fixture.json', import.meta.url), 'utf8'))   // a sample workspace's rules (the live ones are the namingRules setting)

const PROJECTS = [
    ['game-zombie-zone', 'game'], ['mg-look-at-me', 'game'], ['gs-weapons', 'game-addon'], ['gs-fps-controller', 'game-addon'],
    ['lam-maps', 'game-addon'], ['zz-maps', 'game-addon'], ['website-city', 'website'],
]

function mk() {
    const db = new DatabaseSync(':memory:')
    syncSchema(db)
    seedKinds(db)   // the default kinds: 'level' is the one on the maps tab
    const ins = db.prepare("INSERT INTO Project (slug, name, type, updatedAt) VALUES (?,?,?,'2026-01-01')")
    for (const [s, t] of PROJECTS) ins.run(s, s, t)
    return db
}
const item = (db, key, repos, status = 'queue') => db.prepare("INSERT INTO Item (key, title, kind, status, repos, body, priority, createdAt, updatedAt) VALUES (?,?,?,?,?,'',1,'2026-01-01','2026-01-01')").run(key, key, 'task', status, repos)
const asset = (db, pack, weaponId, kind = 'weapon') => db.prepare("INSERT INTO AssetWeapon (pack, weaponId, kind, updatedAt) VALUES (?,?,?,'2026-01-01')").run(pack, weaponId, kind)
const linked = (db, key) => db.prepare('SELECT p.slug FROM ItemProject ip JOIN Item i ON i.id = ip.itemId JOIN Project p ON p.id = ip.projectId WHERE i.key = ? ORDER BY p.slug').all(key).map((r) => r.slug)

test('tokens split on commas and the resolver handles slug, rename, dot-to-gs and general', () => {
    const r = makeResolver(PROJECTS.map(([slug, type], id) => ({ id, slug, type, repoPath: '', settings: '{}' })))
    assert.deepEqual(tokensOf('a, b ,c'), ['a', 'b', 'c'])
    assert.equal(r.resolveToken('game-zombie-zone').slug, 'game-zombie-zone')
    assert.equal(r.resolveToken('/home/x/godot/game-zombie-zone').slug, 'game-zombie-zone')
    assert.equal(r.resolveToken('dot-weapons').slug, 'gs-weapons')
    assert.equal(r.resolveToken('dot-fps-controller').slug, 'gs-fps-controller')
    assert.equal(r.resolveToken('no-such-repo-xyz'), null)
})

test('multi-project items link to every project and count once in a rollup', () => {
    const db = mk()
    item(db, 't1', 'game-zombie-zone, dot-weapons')
    item(db, 't2', 'game-zombie-zone', 'done')
    mapProjects(db, { remapTasks: true })
    assert.deepEqual(linked(db, 't1'), ['game-zombie-zone', 'gs-weapons'])
    const per = countsPerProject(db)
    assert.equal(per['game-zombie-zone'].tasks, 2)
    assert.equal(per['game-zombie-zone'].openTasks, 1)
    assert.equal(per['gs-weapons'].tasks, 1)
    const id = (s) => db.prepare('SELECT id FROM Project WHERE slug = ?').get(s).id
    const roll = db.prepare(countSqls([id('game-zombie-zone'), id('gs-weapons')], false).tasks).get()
    assert.equal(roll.tasks, 2, 't1 is in both projects but counts once')
})

test('mapping is idempotent and keeps the repos text', () => {
    const db = mk()
    asset(db, 'gs-weapons', 'ak47')
    item(db, 't1', 'game-zombie-zone, dot-weapons')
    mapProjects(db, { remapTasks: true })
    const snap = () => JSON.stringify(db.prepare('SELECT itemId, projectId FROM ItemProject ORDER BY 1,2').all())
    const a = snap()
    mapProjects(db, { remapTasks: true })
    assert.equal(snap(), a)
    assert.equal(db.prepare("SELECT repos FROM Item WHERE key = 't1'").get().repos, 'game-zombie-zone, dot-weapons')
    assert.equal(needsMapping(db), false)
})

test('unresolved tokens are reported, dry-run writes nothing', () => {
    const db = mk()
    item(db, 't1', 'game-zombie-zone, game-simple-lobby')
    const dry = mapProjects(db, { dryRun: true, remapTasks: true })
    assert.equal(db.prepare('SELECT COUNT(*) c FROM ItemProject').get().c, 0)
    assert.ok('game-simple-lobby' in dry.tasks.unresolvedTokens)
    const real = mapProjects(db, { remapTasks: true })
    assert.ok('game-simple-lobby' in real.tasks.unresolvedRepoLike)
    assert.deepEqual(linked(db, 't1'), ['game-zombie-zone'])
})

test('a remap corrects a stale link', () => {
    const db = mk()
    item(db, 't1', 'gs-weapons')
    mapProjects(db, { remapTasks: true })
    db.prepare("UPDATE Item SET repos = 'website-city' WHERE key = 't1'").run()
    mapProjects(db, { remapTasks: true })
    assert.deepEqual(linked(db, 't1'), ['website-city'])
})

test('packs: a maps pack belongs to itself and is used by its game; counts per tab', () => {
    const db = mk()
    asset(db, 'lam-maps', 'maps/arena', 'level')
    asset(db, 'lam-maps', 'maps/arena2', 'level')
    asset(db, 'gs-weapons', 'ak47', 'weapon')
    item(db, 't1', 'lam-maps')
    mapProjects(db, { remapTasks: true })
    const roles = db.prepare('SELECT p.slug, pp.pack, pp.role FROM ProjectPack pp JOIN Project p ON p.id = pp.projectId ORDER BY 1,2').all()
    assert.ok(roles.some((r) => r.slug === 'lam-maps' && r.pack === 'lam-maps' && r.role === 'owner'))
    assert.ok(roles.some((r) => r.slug === 'mg-look-at-me' && r.pack === 'lam-maps' && r.role === 'uses'))
    const per = countsPerProject(db)
    assert.equal(per['lam-maps'].maps, 2)
    assert.equal(per['mg-look-at-me'].maps, 2)
    assert.equal(per['gs-weapons'].assets, 1)
    assert.equal(per['gs-weapons'].maps, 0)
    assert.equal(per['lam-maps'].tasks, 1)
})

test('store add/edit with several projects keeps ItemProject in step', () => {
    const db = mk()
    const it = addItem(db, { title: 'multi', projects: ['game-zombie-zone', 'website-city'] })
    assert.deepEqual(linked(db, it.key), ['game-zombie-zone', 'website-city'])
    updateItem(db, it.key, { projects: ['gs-weapons'] })
    assert.deepEqual(linked(db, it.key), ['gs-weapons'])
    assert.equal(db.prepare('SELECT repos FROM Item WHERE key = ?').get(it.key).repos, 'gs-weapons')
    assert.deepEqual(syncItem(db, it.key), ['gs-weapons'])
})

test('planMapping reports before/after per project', () => {
    const db = mk()
    item(db, 't1', 'game-zombie-zone')
    const plan = planMapping(db, { remapTasks: true })
    assert.equal(plan.tasks.links.length, 1)
})
