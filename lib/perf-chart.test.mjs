import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as C from './perf-chart.mjs'

const mk = (vals, extra = {}) => vals.map((v, i) => ({ id: i + 1, ranAt: new Date(Date.UTC(2026, 10, 1 + i)).toISOString(), commit: 'c' + i, label: '', build: '', platform: 'native', role: 'client', map: 'arena', bots: 4, metrics: { fps: v, frame_ms_p95: 1000 / v, ...extra } }))

test('seriesOf skips runs without the metric and keeps order', () => {
    const runs = mk([60, 61, 62]); delete runs[1].metrics.fps
    const s = C.seriesOf(runs, 'fps')
    assert.deepEqual(s.map((p) => p.id), [1, 3])
    assert.equal(s[0].i, 0); assert.equal(s[1].i, 1)
})

test('movingAverage is trailing and n<=1 is identity', () => {
    assert.deepEqual(C.movingAverage([1, 2, 3, 4], 2), [1, 1.5, 2.5, 3.5])
    assert.deepEqual(C.movingAverage([1, 2], 1), [1, 2])
})

test('pointDeltas: pct vs previous, good follows metric direction, budget distance', () => {
    const pts = C.seriesOf(mk([60, 50]), 'fps')
    const d = C.pointDeltas(pts, 'fps', [{ metric: 'fps', min: 55 }])
    assert.equal(d[0].delta, null)
    assert.equal(d[1].delta, -10)
    assert.ok(Math.abs(d[1].pct + 16.666) < 0.01)
    assert.equal(d[1].good, false)
    assert.deepEqual([d[1].budget.kind, d[1].budget.ok, d[1].budget.over], ['min', false, 5])
    const ms = C.pointDeltas(C.seriesOf(mk([50, 60]), 'frame_ms_p95'), 'frame_ms_p95', [{ metric: 'frame_ms_p95', max: 20 }])
    assert.equal(ms[1].good, true); assert.equal(ms[1].budget.ok, true)
})

test('budgetsFor respects scope', () => {
    const b = [{ metric: 'fps', min: 60, platform: 'web' }, { metric: 'fps', min: 30 }]
    assert.equal(C.budgetsFor(b, 'fps', { platform: 'native' }).length, 1)
    assert.equal(C.budgetsFor(b, 'fps', { platform: 'web' }).length, 2)
})

test('regressionReasons names baseline, percent and breached budget', () => {
    const pts = C.seriesOf(mk([60, 60, 60, 60, 40]), 'fps')
    const r = C.regressionReasons(pts, 'fps', [{ metric: 'fps', min: 55 }])
    assert.equal(r.length, 1)
    assert.equal(r[0].id, 5)
    assert.equal(Math.round(r[0].pct), -33)
    assert.ok(r[0].budgetBreach)
    assert.match(r[0].reason, /33% worse than the median of the previous 4 runs/)
    assert.match(r[0].reason, /budget min 55/)
    assert.equal(C.regressionReasons(C.seriesOf(mk([60, 60, 60, 61]), 'fps'), 'fps').length, 0)
})

test('yDomain keeps zero floor for non-negative, log needs positives', () => {
    assert.equal(C.yDomain([0, 2, 3]).lo, 0); assert.ok(C.yDomain([1, 2, 3]).lo >= 0)
    assert.equal(C.yDomain([5, 5]).hi > 5, true)
    assert.equal(C.yDomain([1, 100], { log: true }).log, true)
    assert.equal(C.yDomain([0, 100], { log: true }).log, false)
    assert.ok(C.yDomain([-5, 5]).lo < -5)
})

test('ticks', () => {
    assert.deepEqual(C.niceTicks(0, 100, 5), [0, 20, 40, 60, 80, 100])
    assert.deepEqual(C.logTicks(1, 100), [1, 2, 5, 10, 20, 50, 100])
    const t = C.timeTicks(Date.UTC(2026, 10, 1), Date.UTC(2026, 10, 8))
    assert.ok(t.length >= 3); assert.equal(t[0].label, 'Nov 1')
})

test('nearest picks the closest point', () => {
    assert.equal(C.nearest([{ t: 0 }, { t: 10 }, { t: 20 }], 14), 1)
    assert.equal(C.nearest([], 1), -1)
})

test('trendOf direction and not-enough-data', () => {
    assert.equal(C.trendOf('fps', [60, 59, 58, 57, 56]).dir, 'worse')
    assert.equal(C.trendOf('frame_ms_p95', [10, 9, 8, 7]).dir, 'better')
    assert.equal(C.trendOf('fps', [60, 60.1, 60]).dir, 'flat')
    assert.equal(C.trendOf('fps', [60, 50]).enough, false)
})

test('lowData explains one and two point series', () => {
    assert.match(C.lowData(C.seriesOf(mk([60]), 'fps')), /Only one run/)
    assert.match(C.lowData(C.seriesOf(mk([60, 61]), 'fps')), /three runs/)
    assert.equal(C.lowData(C.seriesOf(mk([60, 61, 62]), 'fps')), null)
})

test('statusCards: budget verdict, regressions, worst metric', () => {
    const runs = mk([60, 60, 60, 60, 40])
    const c = C.statusCards(runs, ['fps', 'frame_ms_p95'], [{ metric: 'fps', min: 55 }])
    assert.equal(c.budgets.pass, false)
    assert.deepEqual(c.budgets.failing, ['fps'])
    assert.equal(c.fps.latest, 40)
    assert.ok(c.regressions >= 1)
    assert.equal(c.worst.metric, 'frame_ms_p95')
    assert.equal(C.worstMetrics(c)[0].score > 0, true)
    assert.equal(C.statusCards(mk([60, 60, 60]), ['fps'], [{ metric: 'fps', min: 55 }]).budgets.pass, true)
})

test('heatmap flags only regressions, null without baseline', () => {
    const h = C.heatmap(mk([60, 60, 60, 40]), ['fps'])
    const cells = h.rows[0].cells
    assert.equal(cells[0].z, null)
    assert.equal(cells[3].flag, true)
    assert.ok(cells[3].z > 30)
    assert.equal(cells[1].flag, false)
})

test('histogram counts every value', () => {
    const h = C.histogram([1, 1, 2, 9], 4)
    assert.equal(h.bins.reduce((a, b) => a + b.n, 0), 4)
    assert.equal(h.max, 3)
    assert.deepEqual(C.histogram([]).bins, [])
})

test('diffRuns verdicts and budget', () => {
    const [a, b] = mk([60, 40])
    b.metrics.extra = 1
    const d = Object.fromEntries(C.diffRuns(a, b, [{ metric: 'fps', min: 55 }]).map((r) => [r.metric, r]))
    assert.equal(d.fps.verdict, 'worse'); assert.equal(d.fps.budget.ok, false)
    assert.equal(d.frame_ms_p95.verdict, 'worse')
    assert.equal(d.extra.verdict, 'new')
})

test('fmt and fmtPct', () => {
    assert.equal(C.fmt(16.666, 'ms'), '16.7 ms'); assert.equal(C.fmt(null), '-'); assert.equal(C.fmtPct(-3.14), '-3.1%')
})
