// Run: node --test lib/perf.test.mjs
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { execSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-test-'))
process.env.NIGHTLY_DB = path.join(dir, 'n.db')
process.env.NIGHTLY_PERF_DIR = path.join(dir, 'perf')
const S = await import('./store.mjs')
const P = await import('./perf.mjs')
const PS = await import('./perf-store.mjs')
let db

before(() => {
    const ddl = execSync('npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script', { cwd: path.join(import.meta.dirname, '..'), encoding: 'utf8', env: { ...process.env } })
    db = new DatabaseSync(process.env.NIGHTLY_DB)
    db.exec(ddl)
    PS.migrate(db) // idempotent on top of the pushed schema
    PS.migrate(db)
})

const report = (fps, p95, extra = {}) => JSON.stringify({ version: 2, frames: fps * 10, wall_s: 10, p50_ms: 10, p95_ms: p95, p99_ms: p95 + 5, worst_ms: 90,
    context: { game: { map: 'arena', bots: 4 }, machine: { gpu: 'GPU X' }, build: { commit: 'abc1234567' } },
    functions: [{ name: 'Mod::tick', path: 'physics;Mod::tick', self_ms: 3, total_ms: 5, calls: 10 }], ...extra })

test('parseFolded and groupOf', () => {
    const rows = P.parseFolded('physics;a;b 300\nprocess;c 100\n')
    assert.equal(rows.length, 2)
    assert.throws(() => P.parseFolded('broken line\n'), /not "stack count"/)
    assert.equal(P.groupOf('physics;a;b'), 'physics')
    assert.equal(P.groupOf('xyz'), 'other')
})

test('budget spec parse and evaluate', () => {
    const b = P.parseBudgetSpec('frame_ms_p95<=33@platform=native,bots=4')
    assert.deepEqual(b, { metric: 'frame_ms_p95', max: 33, platform: 'native', bots: 4 })
    assert.throws(() => P.parseBudgetSpec('nonsense'))
    const run = { platform: 'native', role: 'client', map: '', bots: 4 }
    assert.equal(P.evaluateBudgets([b], run, { frame_ms_p95: 40 }).breaches.length, 1)
    assert.equal(P.evaluateBudgets([b], run, { frame_ms_p95: 20 }).breaches.length, 0)
    assert.equal(P.evaluateBudgets([b], { ...run, platform: 'web' }, { frame_ms_p95: 99 }).breaches.length, 0, 'scope respected')
    assert.equal(P.evaluateBudgets([b], run, {}).checked.length, 0, 'missing metric is not checked')
    assert.equal(P.evaluateBudgets([{ metric: 'fps', min: 60 }], run, { fps: 30 }).breaches[0].op, 'min')
})

test('compareMetrics: direction-aware verdicts', () => {
    const rows = Object.fromEntries(P.compareMetrics({ fps: 60, frame_ms_p95: 20, x: 1 }, { fps: 30, frame_ms_p95: 10, y: 2 }).map((r) => [r.metric, r]))
    assert.equal(rows.fps.verdict, 'worse')
    assert.equal(rows.frame_ms_p95.verdict, 'better')
    assert.equal(rows.x.verdict, 'gone')
    assert.equal(rows.y.verdict, 'new')
    assert.equal(P.compareMetrics({ fps: 60 }, { fps: 61 })[0].verdict, 'same', 'inside the noise band')
})

test('parseAny tolerates json, folded and txt', () => {
    const j = P.parseAny(report(58, 22), 'r.json')
    assert.equal(j.metrics.fps, 58)
    assert.equal(j.metrics.frame_ms_p95, 22)
    assert.equal(P.parseAny('a;b 5\nc 7\n', 'x.folded').kind, 'folded')
    assert.throws(() => P.parseAny('{not json', 'bad.json'))
    assert.ok(P.parseAny(JSON.stringify({ frames: 300, wall_s: 10, p50_ms: 30 }), 'old.json').metrics.fps === 30, 'old report without versions')
})

test('regressionMarkers flags a step up', () => {
    const s = [10, 10, 10, 10, 10, 20, 20].map((v, i) => ({ x: i, metric: 'frame_ms_p95', value: v }))
    assert.deepEqual(P.regressionMarkers(s, 'frame_ms_p95'), [5, 6])
    assert.deepEqual(P.regressionMarkers(s, 'fps'), [], 'a rise in a higher-is-better metric is not a regression')
})

test('ingest: stores metrics, functions, artefact; unknown game refused', () => {
    assert.throws(() => PS.ingest(db, P.parseAny(report(60, 10), 'a.json'), { game: 'nope' }), /unknown game/)
    PS.saveGame(db, { slug: 'g', name: 'G', repo: 'g-repo', budgets: ['frame_ms_p95<=16.7@platform=native', 'fps>=60'] })
    assert.throws(() => PS.saveGame(db, { slug: 'g', name: 'again' }), /already exists/)
    assert.throws(() => PS.saveGame(db, { slug: 'Bad Id' }), /lowercase/)
    const r = PS.ingest(db, P.parseAny(report(61, 10), 'a.json'), { game: 'g', platform: 'native', raw: report(61, 10) })
    assert.equal(r.breaches.length, 0)
    assert.equal(PS.runMetrics(db, r.run.id).fps, 61)
    assert.equal(PS.runFuncs(db, r.run.id)[0].name, 'Mod::tick')
    assert.ok(PS.hasArtefact(db.prepare('SELECT artefact FROM PerfRun WHERE id=?').get(r.run.id).artefact, 'report.json'))
    assert.match(r.run.ranAt, /^\d{4}-\d\d-\d\dT.*Z$/)
})

test('breach files one item per game+metric, adds notes, resolves on pass', () => {
    const bad = () => PS.ingest(db, P.parseAny(report(30, 50), 'b.json'), { game: 'g', platform: 'native', raw: report(30, 50) })
    const a = bad()
    assert.equal(a.breaches.length, 2)
    assert.ok(a.findings.every((f) => f.created && f.itemKey.startsWith('perf-g-')))
    const items = () => db.prepare("SELECT count(*) n FROM Item WHERE key LIKE 'perf-g-%'").get().n
    assert.equal(items(), 2)
    const b = bad()
    assert.ok(b.findings.every((f) => !f.created), 'second breach does not file again')
    assert.equal(items(), 2)
    const notes = db.prepare("SELECT count(*) n FROM Note WHERE itemId IN (SELECT id FROM Item WHERE key LIKE 'perf-g-%')").get().n
    assert.equal(notes, 2)
    PS.ingest(db, P.parseAny(report(75, 8), 'c.json'), { game: 'g', platform: 'native', raw: report(75, 8) })
    assert.equal(db.prepare("SELECT count(*) n FROM PerfFinding WHERE status='open'").get().n, 0)
    // a closed item gets a fresh one when the metric breaks again
    db.prepare("UPDATE Item SET status='done' WHERE key LIKE 'perf-g-%'").run()
    bad()
    assert.equal(items(), 4)
})

test('size limit fails loudly and leaves no run behind; 0 = unlimited', () => {
    const before = db.prepare('SELECT count(*) n FROM PerfRun').get().n
    S.setSetting(db, 'perfMaxArtifactBytes', '50')
    assert.throws(() => PS.ingest(db, P.parseAny(report(60, 10), 'a.json'), { game: 'g', raw: report(60, 10) }), /perfMaxArtifactBytes/)
    assert.equal(db.prepare('SELECT count(*) n FROM PerfRun').get().n, before)
    S.setSetting(db, 'perfMaxArtifactBytes', '0')
    PS.ingest(db, P.parseAny(report(60, 10), 'a.json'), { game: 'g', raw: report(60, 10) })
    assert.equal(db.prepare('SELECT count(*) n FROM PerfRun').get().n, before + 1)
    S.setSetting(db, 'perfMaxArtifactBytes', '-3')
    assert.throws(() => PS.ingest(db, P.parseAny(report(60, 10), 'a.json'), { game: 'g' }), />= 0/)
    S.setSetting(db, 'perfMaxArtifactBytes', '0')
})

test('retention by run count removes rows and files', () => {
    S.setSetting(db, 'perfRetentionRuns', '2')
    PS.prune(db, 'g')
    assert.equal(db.prepare("SELECT count(*) n FROM PerfRun WHERE game='g'").get().n, 2)
    assert.equal(db.prepare('SELECT count(*) n FROM PerfMetric WHERE runId NOT IN (SELECT id FROM PerfRun)').get().n, 0, 'metrics cascade')
    S.setSetting(db, 'perfRetentionRuns', '0')
})

test('parses the dot-profiler perf-report v1 envelope', () => {
    const r = P.parseReportJson({
        schema: 'gamespice.perf-report', schema_version: 1, game_id: 'fatal-contact', build: { commit: 'abc1234', branch: 'main' },
        platform: 'native', role: 'standalone', scene: 'res://maps/arena.tscn', bots: 4, duration_s: 30, resolution: '1920x1080', gpu: 'RTX',
        frame: { count: 1800, ms: { avg: 10, p50: 9, p95: 16, p99: 20, max: 40 }, fps_avg: 100, over_budget: 3 },
        tick: { ms: { avg: 2.5 }, dropped: 1 }, render: { draw_calls: { avg: 900 } }, memory: { static_mb: { end: 512 } },
        budget: [{ id: 'physics.scripts', ms_per_frame: 3, addon: 'dot-net' }, { id: 'net.snapshot', ms_per_frame: 1, addon: 'game' }],
    })
    assert.equal(r.run.game, 'fatal-contact'); assert.equal(r.run.role, 'client'); assert.equal(r.run.map, 'arena'); assert.equal(r.run.commit, 'abc1234')
    assert.equal(r.metrics.fps, 100); assert.equal(r.metrics.frame_ms_p95, 16); assert.equal(r.metrics.tick_ms, 2.5); assert.equal(r.metrics.memory_mb, 512)
    assert.equal(r.functions[0].name, 'physics.scripts'); assert.equal(r.functions[0].grp, 'physics'); assert.equal(r.functions[0].addon, 'dot-net')
})
