// Run: node --test lib/releases-sync.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { add, list, deploy, updateRelease, undeploy, removeRelease } from './feeds.mjs'
import { channelOf, ciByCommit, slugOf, sync } from './releases-sync.mjs'
import { memDb } from './testdb.mjs'

test('tag parsing, channel and github slug', () => {
    assert.equal(channelOf('v1.2.3'), 'stable'); assert.equal(channelOf('v1.2.3-rc1'), 'dev'); assert.equal(channelOf('v1.2'), 'stable')
    assert.equal(slugOf('git@github.com:gamespice-platform/map.git\n'), 'gamespice-platform/map')
    assert.equal(slugOf('https://github.com/a/b'), 'a/b'); assert.equal(slugOf('/local/path'), '')
})
test('ciByCommit: failing beats passing, running is pending, no run is absent', () => {
    const runs = [{ headSha: 'a', status: 'completed', conclusion: 'success' }, { headSha: 'b', status: 'completed', conclusion: 'success' }, { headSha: 'b', status: 'completed', conclusion: 'failure' }, { headSha: 'c', status: 'in_progress', conclusion: '' }]
    assert.deepEqual(ciByCommit(runs, ['a', 'b', 'c', 'd']), { a: 'passing', b: 'failing', c: 'pending' })
})
test('sync imports tags idempotently and never touches deployedTo', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'rel-')), repo = path.join(root, 'game-x')
    const g = (...a) => assert.equal(spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).status, 0)
    spawnSync('git', ['init', '-q', repo])
    for (const v of ['v0.1.0', 'v0.1.1', 'v0.2.0-rc1']) { writeFileSync(path.join(repo, 'f'), v); g('add', '.'); g('commit', '-qm', `work for ${v}`); g('tag', '-a', v, '-m', `release ${v}`) }
    const db = memDb()
    assert.equal(sync(db, { roots: [root], ci: false }).added, 3)
    assert.equal(sync(db, { roots: [root], ci: false }).added, 0)
    const rows = list(db, 'release'), by = Object.fromEntries(rows.map((r) => [r.version, r]))
    assert.equal(rows.length, 3); assert.equal(by['v0.2.0-rc1'].channel, 'dev'); assert.equal(by['v0.1.1'].rollback, 'v0.1.0')
    assert.match(by['v0.1.1'].changelog, /release v0.1.1\n- work for v0.1.1/)
    deploy(db, { repo: 'game-x', version: 'v0.1.1', to: 'prod' })
    sync(db, { roots: [root], ci: false })
    assert.equal(list(db, 'release').find((r) => r.version === 'v0.1.1').deployedTo, 'prod')
})
test('updateRelease / undeploy / removeRelease', () => {
    const db = memDb()
    add(db, 'release', { repo: 'r', version: 'v1.0.0' })
    deploy(db, { repo: 'r', version: 'v1.0.0', to: 'dev' }); deploy(db, { repo: 'r', version: 'v1.0.0', to: 'prod' })
    updateRelease(db, { repo: 'r', version: 'v1.0.0', changelog: 'notes', ci: 'passing' })
    assert.deepEqual(undeploy(db, { repo: 'r', version: 'v1.0.0', from: 'dev' }).deployedTo, 'prod')
    const r = list(db, 'release')[0]; assert.deepEqual([r.changelog, r.ci], ['notes', 'passing'])
    assert.throws(() => updateRelease(db, { repo: 'r', version: 'v1.0.0', ci: 'bogus' }), /ci must be one of/)
    assert.throws(() => updateRelease(db, { repo: 'r', version: 'nope' }), /no release/)
    removeRelease(db, { repo: 'r', version: 'v1.0.0' }); assert.equal(list(db, 'release').length, 0)
})
