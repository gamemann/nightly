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
    S.setSetting(db, 'perfRegression', '0'); S.setSetting(db, 'perfOffenderMinMs', '1000000') // older tests count items; the new ones switch these on
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

// ---------- part 2: tokens, folded, regressions, offenders, RSI ----------

const mk = (game, metrics, funcs = [], at, extra = {}) => PS.ingest(db, { kind: 'bench', run: {}, metrics, functions: funcs }, { game, platform: 'native', role: 'client', map: 'arena', bots: 4, ranAt: at, ...extra })
const day = (n) => new Date(Date.UTC(2026, 10, 1 + n)).toISOString()
const fn = (name, selfMs, grp = 'script') => ({ name, selfMs, totalMs: selfMs, calls: 1, grp, per: 'frame' })

test('migrate is idempotent, backs up only when there is work, and is safe on an old PerfFinding', () => {
    const old = new DatabaseSync(path.join(dir, 'old.db'))
    old.exec(fs.readFileSync(path.join(import.meta.dirname, '..', 'prisma', 'migrations', '20261120000000_perf', 'migration.sql'), 'utf8'))
    assert.equal(PS.pending(old), true)
    const bak = PS.migrate(old, { backup: true })
    assert.ok(bak && fs.existsSync(bak), 'backup file written before the migration')
    assert.equal(PS.pending(old), false)
    assert.equal(PS.migrate(old, { backup: true }), '', 'nothing pending = no backup')
    PS.migrate(old)
    assert.ok(old.prepare("SELECT 1 FROM pragma_table_info('PerfFinding') WHERE name='history'").get())
    old.close()
})

test('tokens: hashed at rest, shown once, scoped per game, revocable, no secret in errors', () => {
    PS.saveGame(db, { slug: 'tk', name: 'Tok' })
    PS.saveGame(db, { slug: 'tk2', name: 'Tok2' })
    assert.equal(PS.authorizeIngest(db, '', 'tk'), null, 'no token exists: open')
    const t = PS.addToken(db, { name: 'runner-a', game: 'tk' })
    assert.match(t.token, /^nps_/)
    const row = db.prepare('SELECT * FROM PerfToken WHERE name = ?').get('runner-a')
    assert.ok(!JSON.stringify(row).includes(t.token), 'the secret is not stored')
    assert.equal(row.hash.length, 64)
    assert.throws(() => PS.authorizeIngest(db, '', 'tk'), /token required/)
    assert.throws(() => PS.authorizeIngest(db, 'nps_wrong', 'tk'), (e) => /not recognised/.test(e.message) && !e.message.includes('nps_wrong'))
    assert.equal(PS.authorizeIngest(db, t.token, 'tk').name, 'runner-a')
    assert.throws(() => PS.authorizeIngest(db, t.token, 'tk2'), (e) => /limited to game "tk"/.test(e.message) && !e.message.includes(t.token))
    assert.ok(db.prepare('SELECT lastUsedAt FROM PerfToken WHERE name = ?').get('runner-a').lastUsedAt)
    assert.throws(() => PS.addToken(db, { name: 'runner-a' }), /exists/)
    assert.equal(PS.listTokens(db).some((x) => 'hash' in x || 'token' in x), false)
    PS.revokeToken(db, 'runner-a')
    assert.equal(PS.authorizeIngest(db, '', 'tk'), null, 'all revoked: open again')
    assert.throws(() => PS.authorizeIngest(db, '', 'tk', { strict: true }), /token required/)
    S.setSetting(db, 'perfRequireToken', '1')
    assert.throws(() => PS.authorizeIngest(db, '', 'tk'), /token required/)
    S.setSetting(db, 'perfRequireToken', '0')
})

test('v1 report with embedded stacks or an envelope with .folded feeds the icicle view; unknown v1.1 fields are tolerated', () => {
    const v1 = { schema: 'gamespice.perf-report', schema_version: 1, game_id: 'v1g', platform: 'native', role: 'standalone', frame: { count: 100, ms: { avg: 10, p95: 16 }, fps_avg: 100 },
        baseline: { future: { x: 1 } }, brand_new_section: [1, 2] }
    const folded = 'physics;Mod::tick 300\nprocess;Ui::draw 120\n'
    const e = P.splitEnvelope(JSON.stringify({ report: v1, folded }))
    assert.equal(e.folded, folded)
    const a = P.parseAny(e.text, 'r.json')
    assert.equal(a.metrics.fps, 100)
    PS.saveGame(db, { slug: 'v1g', name: 'V1' })
    const r = PS.ingest(db, a, { game: 'v1g', folded: e.folded, raw: e.text })
    assert.ok(fs.existsSync(path.join(process.env.NIGHTLY_PERF_DIR, r.run.artefact, 'stacks.folded')))
    const emb = P.parseAny(JSON.stringify({ ...v1, folded }), 'r.json')
    assert.ok(emb.functions.length >= 2, 'functions derived from embedded stacks')
    assert.equal(P.splitEnvelope('{"schema":"x"}').folded, '')
    assert.equal(P.unitLabel('fps'), '')
    assert.equal(P.unitLabel('tick_ms'), 'ms')
})

test('detectRegression is noise-aware: a jittery history needs a bigger step', () => {
    const steady = [60, 60, 61, 59, 60]
    assert.equal(P.detectRegression('fps', 50, steady).regressed, true)
    assert.equal(P.detectRegression('fps', 58.5, steady).regressed, false, 'inside the 5% floor')
    assert.equal(P.detectRegression('fps', 70, steady).improved, true)
    const noisy = [40, 80, 55, 70, 45]
    assert.equal(P.detectRegression('fps', 45, noisy).regressed, false, 'within the history spread')
    assert.equal(P.detectRegression('fps', 50, [60, 60]).regressed, false, 'too few runs = no verdict')
    assert.equal(P.detectRegression('frame_ms_p95', 40, [20, 21, 20, 19, 20]).regressed, true, 'lower-is-better direction')
    assert.equal(P.detectRegression('frame_ms_p95', 10, [20, 21, 20, 19, 20]).regressed, false)
    assert.equal(P.detectRegression('fps', 50, steady, { noisePct: 50 }).regressed, false, 'configurable threshold')
})

test('pickOffenders skips engine and wait rows, applies threshold and top-N', () => {
    const rows = [fn('Mod::a', 5), fn('Mod::b', 3), fn('Mod::c', 0.2), fn('physics', 9), fn('idle', 8, 'wait'), fn('Mod::d', 2)]
    assert.deepEqual(P.pickOffenders(rows, { minMs: 1, top: 2 }).map((r) => r.name), ['Mod::a', 'Mod::b'])
    assert.deepEqual(P.pickOffenders(rows, { minMs: 1, top: 0 }).map((r) => r.name), ['Mod::a', 'Mod::b', 'Mod::d'])
})

test('regression files one deduped item per game+metric+scope, none on a cold start', () => {
    S.setSetting(db, 'perfRegression', '1')
    PS.saveGame(db, { slug: 'rg', name: 'Reg' })
    for (let i = 0; i < 4; i++) { const r = mk('rg', { fps: 60 + (i % 2), tick_ms: 2 }, [], day(i)); assert.equal(r.regressions.length, 0) }
    const bad = mk('rg', { fps: 40, tick_ms: 2 }, [], day(5))
    assert.deepEqual(bad.regressions.map((r) => r.regressionOf), ['fps'])
    assert.ok(bad.regressions[0].created && bad.regressions[0].itemKey.startsWith('perf-rg-regress-fps'))
    const again = mk('rg', { fps: 38, tick_ms: 2 }, [], day(6))
    assert.equal(again.regressions[0]?.created, false, 'same finding: a note, not a second item')
    assert.equal(db.prepare("SELECT count(*) n FROM Item WHERE key LIKE 'perf-rg-regress-%'").get().n, 1)
    // another scope has its own history: no verdict yet
    const other = mk('rg', { fps: 10 }, [], day(7), { map: 'other' })
    assert.equal(other.regressions.length, 0)
    S.setSetting(db, 'perfRegression', '0')
    assert.equal(mk('rg', { fps: 5 }, [], day(8)).regressions.length, 0, 'switched off')
    S.setSetting(db, 'perfRegression', '0')
})

test('top offenders file one item per game+function and the RSI loop measures the fix', () => {
    S.setSetting(db, 'perfOffenderMinMs', '1')
    PS.saveGame(db, { slug: 'of', name: 'Off' })
    mk('of', { fps: 60 }, [fn('Mod::slow', 6), fn('Mod::ok', 0.3), fn('physics', 9)], day(0))
    const r = mk('of', { fps: 60 }, [fn('Mod::slow', 6), fn('Mod::ok', 0.3), fn('physics', 9)], day(1))
    assert.deepEqual(r.offenders.map((o) => o.fn), ['Mod::slow'])
    const key = r.offenders[0].itemKey
    assert.equal(key, 'perf-of-fn-mod-slow')
    assert.equal(mk('of', { fps: 60 }, [fn('Mod::slow', 6)], day(2)).offenders[0].created, false, 'deduped')
    assert.equal(db.prepare("SELECT count(*) n FROM Item WHERE key LIKE 'perf-of-fn-%'").get().n, 1)
    let rsi = PS.listRsi(db, { game: 'of' })
    assert.equal(rsi[0].state, 'found')
    // the item closes: fixed, still waiting for a run
    S.updateItem(db, key, { status: 'done' })
    PS.syncRsi(db, PS.getGame(db, 'of'))
    rsi = PS.listRsi(db, { game: 'of' })
    assert.equal(rsi[0].state, 'fixed'); assert.ok(Math.abs(rsi[0].before - 6) < 1e-9)
    // a run in another scope does not remeasure; one in the same scope does, with the delta
    mk('of', { fps: 60 }, [fn('Mod::slow', 6)], day(3), { map: 'elsewhere' })
    assert.equal(PS.listRsi(db, { game: 'of' })[0].state, 'fixed')
    const after = mk('of', { fps: 60 }, [fn('Mod::slow', 0.5)], day(4))
    rsi = PS.listRsi(db, { game: 'of' })
    assert.equal(rsi[0].state, 'remeasured'); assert.equal(rsi[0].after, 0.5); assert.ok(rsi[0].delta < 0 && rsi[0].pct < -70)
    assert.equal(rsi[0].remeasuredRunId, after.run.id)
    // it creeps back above the threshold: a new cycle, old one kept in history
    for (let i = 5; i < 9; i++) mk('of', { fps: 60 }, [fn('Mod::slow', 7)], day(i))
    rsi = PS.listRsi(db, { game: 'of' })
    assert.equal(rsi[0].state, 'found'); assert.equal(rsi[0].history.length, 1)
    assert.notEqual(rsi[0].itemKey, key, 'a fresh item for the new cycle')
})

test('wontfix dismisses an offender and it is not filed again', () => {
    mk('of', { fps: 60 }, [fn('Mod::slow', 7)], day(20))
    const cur = PS.listRsi(db, { game: 'of' })[0]
    S.updateItem(db, cur.itemKey, { status: 'wontfix' })
    mk('of', { fps: 60 }, [fn('Mod::slow', 7)], day(21))
    assert.equal(PS.listRsi(db, { game: 'of' })[0].state, 'dismissed')
    mk('of', { fps: 60 }, [fn('Mod::slow', 7)], day(22))
    assert.equal(db.prepare("SELECT count(*) n FROM Item WHERE key LIKE 'perf-of-fn-mod-slow%'").get().n, 2)
})
