// Run: node --test lib/rsi-maps.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCensus, judge, syncMaps, scanLogs } from './rsi-maps.mjs'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { memDb } from './testdb.mjs'

const log = (map, total, alpha) => `inf playlot  playlot starting
inf playlot  map ready map=pg_flatgrass players=1
inf playlot  map ready map=${map} players=1
PERF_BENCH_LOG t=1 mesh census: 10 visible mesh instances
PERF_BENCH_LOG t=1 census 10  ArrayMesh opaque surfaces=1 shadow=0 under Node3D x
PERF_BENCH_LOG t=2 mesh census: ${total} visible mesh instances
PERF_BENCH_LOG t=2 census ${alpha}  BoxMesh alpha under Node3D of World
PERF_BENCH_LOG t=2 census 7  BoxMesh opaque surfaces=1 shadow=1 under Node3D y
PERF_BENCH_LOG t=2 census 3  ArrayMesh alpha surfaces=1 shadow=1 under Node3D z
`
test('parseCensus: last map, last census block, alpha boxes only', () => {
    const c = parseCensus(log('pgc_x', 700, 120))
    assert.deepEqual(c, { game: 'playlot', map: 'pgc_x', meshes: 700, alphaBoxes: 120, alphaTotal: 123 })
    assert.equal(parseCensus('nothing here'), null)
})
test('foreign game: no game line uses the fallback; the log name pattern is configurable', () => {
    const anon = log('arena_1', 700, 0).split('\n').slice(1).join('\n')
    assert.equal(parseCensus(anon).game, 'game')
    assert.equal(parseCensus(anon, 'mygame').game, 'mygame')
    const dir = mkdtempSync(path.join(tmpdir(), 'census-'))
    writeFileSync(path.join(dir, '2026-01-01-draws-bench.log'), anon)
    writeFileSync(path.join(dir, '2026-01-02-mesh-stats.txt'), log('other', 900, 0))
    assert.deepEqual(scanLogs(dir).map((c) => c.subject), ['game/arena_1'])
    assert.deepEqual(scanLogs(dir, { logs: 'mesh-stats', game: 'x' }).map((c) => c.subject), ['playlot/other'])
    assert.deepEqual(scanLogs(dir, { logs: '(' }).map((c) => c.subject), ['game/arena_1'])   // bad regex: default pattern
})
test('judge: budgets, severity, 0 disables', () => {
    const c = { meshes: 700, alphaBoxes: 300, log: 'l' }
    assert.deepEqual(judge(c).map((f) => [f.code, f.severity]), [['MESH_OVER_BUDGET', 'warn'], ['ALPHA_BOXES', 'error']])
    assert.deepEqual(judge(c, { budget: 0, alphaBudget: 0 }), [])
    assert.equal(judge({ meshes: 1300, alphaBoxes: 0, log: 'l' })[0].severity, 'error')
})
test('syncMaps raises, updates, and closes when the map drops under budget', () => {
    const db = memDb()
    const c = { subject: 'playlot/pgc_x', game: 'playlot', map: 'pgc_x', meshes: 900, alphaBoxes: 80, log: 'a.log' }
    assert.equal(syncMaps(db, { censuses: [c] }).raised, 2)
    assert.equal(syncMaps(db, { censuses: [c] }).raised, 2)
    assert.equal(db.prepare("SELECT COUNT(*) n FROM RsiFinding WHERE domain='maps'").get().n, 2)
    const r = syncMaps(db, { censuses: [{ ...c, meshes: 300, alphaBoxes: 5 }] })
    assert.equal(r.closed, 2)
    assert.deepEqual(db.prepare("SELECT DISTINCT status, state FROM RsiFinding WHERE domain='maps'").all().map((x) => ({ ...x })), [{ status: 'resolved', state: 'remeasured' }])
    assert.equal(syncMaps(db, { censuses: [c] }).raised, 2)   // regresses -> open again
    assert.equal(db.prepare("SELECT COUNT(*) n FROM RsiFinding WHERE status='open'").get().n, 2)
})
