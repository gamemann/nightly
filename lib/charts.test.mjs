import test from 'node:test'
import assert from 'node:assert/strict'
import { statusByDay, successRate, runSeries, startHeat, perSchedule, timelineOf, scoreBins, passByGroup, flagCounts, worstOffenders, qaTrend, qaAreaGrid, verdictParts, reviewProgress, verdictsByDay, fmtMinutes, fmtUsd, stateOf, CAT } from './charts.mjs'

const NOW = Date.parse('2026-11-22T12:00:00Z')
const run = (id, at, status, extra = {}) => ({ id, startedAt: at, status, ...extra })

test('statusByDay buckets by status, fills empty days, ignores out of window', () => {
    const b = statusByDay([run(1, '2026-11-22T01:00:00Z', 'ok'), run(2, '2026-11-22T05:00:00Z', 'failed'), run(3, '2026-11-21T05:00:00Z', 'findings'), run(4, '2026-01-01T00:00:00Z', 'ok'), run(5, '2026-11-22T06:00:00Z', 'weird')], { days: 3, now: NOW })
    assert.equal(b.length, 3)
    assert.deepEqual(b.map((x) => x.key), ['2026-11-20', '2026-11-21', '2026-11-22'])
    assert.equal(b[0].total, 0)
    assert.equal(b[2].segments.ok, 1); assert.equal(b[2].segments.failed, 1); assert.equal(b[2].segments.skipped, 1)
    assert.deepEqual(b[1].ids, [3])
})
test('stateOf maps unknown to skipped', () => { assert.equal(stateOf('x'), 'skipped'); assert.equal(stateOf('ok'), 'ok') })
test('successRate counts findings as completed, excludes running', () => {
    assert.equal(successRate([]), null)
    assert.equal(successRate([{ status: 'running' }]), null)
    assert.equal(successRate([{ status: 'ok' }, { status: 'findings' }, { status: 'failed' }, { status: 'running' }, { status: 'skipped' }]), 0.5)
})
test('runSeries sorts, filters non numbers, keeps last n', () => {
    const s = runSeries([run(2, '2026-11-02T00:00:00Z', 'ok', { minutes: 5 }), run(1, '2026-11-01T00:00:00Z', 'ok', { minutes: 3 }), run(3, '2026-11-03T00:00:00Z', 'ok', { minutes: null }), run(4, '2026-11-04T00:00:00Z', 'ok', { minutes: 9 })], 'minutes', { last: 2 })
    assert.deepEqual(s.map((x) => x.v), [5, 9])
})
test('startHeat grid is Monday first and honours offset', () => {
    const h = startHeat(['2026-11-23T08:30:00Z', '2026-11-23T08:45:00Z', '2026-11-22T23:00:00Z', 'nope'])
    assert.equal(h.grid[0][8], 2) // Monday
    assert.equal(h.grid[6][23], 1) // Sunday
    assert.equal(h.total, 3); assert.equal(h.max, 2)
    assert.equal(startHeat(['2026-11-22T23:00:00Z'], { offsetMin: 120 }).grid[0][1], 1)
})
test('perSchedule groups, rolls and strips', () => {
    const s = { id: 1, name: 'a' }
    const r = perSchedule([run(3, '2026-11-03T00:00:00Z', 'failed', { schedule: s, minutes: 10 }), run(1, '2026-11-01T00:00:00Z', 'ok', { schedule: s, minutes: 2 }), run(2, '2026-11-02T00:00:00Z', 'ok', { schedule: s, minutes: 4 }), run(4, '2026-11-04T00:00:00Z', 'ok')])
    const a = r.find((x) => x.id === 1)
    assert.equal(a.total, 3); assert.equal(a.rate, 2 / 3); assert.deepEqual(a.roll, [100, 100, 67]); assert.equal(a.medianMinutes, 4)
    assert.deepEqual(a.strip.map((x) => x.state), ['ok', 'ok', 'failed'])
    assert.equal(r.find((x) => x.id === null).name, 'no schedule')
})
test('timelineOf drops past and far fires, sorts', () => {
    const t = timelineOf([{ scheduleId: 1, name: 'b', at: NOW + 3_600_000 }, { scheduleId: 2, name: 'a', at: NOW - 1 }, { scheduleId: 3, name: 'c', at: NOW + 100 * 3_600_000 }, { scheduleId: 4, name: 'd', at: new Date(NOW + 1_800_000).toISOString() }], { now: NOW, hours: 48 })
    assert.deepEqual(t.map((x) => x.name), ['d', 'b']); assert.equal(t[0].inHours, 0.5)
})
test('scoreBins covers 0..100 with tiers and clamps', () => {
    const b = scoreBins([{ score: 0 }, { score: 39 }, { score: 40 }, { score: 69 }, { score: 70 }, { score: 100 }, { score: 150 }, { score: NaN }, {}])
    assert.equal(b.length, 10); assert.equal(b[0].count, 1); assert.equal(b[3].count, 1); assert.equal(b[9].count, 2)
    assert.deepEqual([b[0].tier, b[4].tier, b[7].tier], ['fail', 'warn', 'pass'])
    assert.equal(b[9].hi, 100)
})
test('passByGroup sorts weakest first and supports multi keys', () => {
    const g = passByGroup([{ pack: 'a', score: 90, pass: true }, { pack: 'a', score: 10, pass: false }, { pack: 'b', score: 80, pass: true }, { pack: '', score: 1, pass: false }], (r) => r.pack)
    assert.deepEqual(g.map((x) => x.key), ['a', 'b']); assert.equal(g[0].rate, 0.5); assert.equal(g[0].mean, 50)
    assert.equal(passByGroup([{ t: ['x', 'y'], score: 1, pass: true }], (r) => r.t).length, 2)
})
test('flagCounts filters by tab and sorts', () => {
    const rows = [{ flags: [{ code: 'a', severity: 'bad', tab: 'models' }, { code: 'b', severity: 'warn', tab: 'sounds' }] }, { flags: [{ code: 'a', severity: 'bad', tab: 'models' }] }, {}]
    assert.deepEqual(flagCounts(rows).map((x) => [x.code, x.n]), [['a', 2], ['b', 1]])
    assert.deepEqual(flagCounts(rows, 'sounds').map((x) => x.code), ['b'])
})
test('worstOffenders lowest first', () => {
    assert.deepEqual(worstOffenders([{ weaponId: 'b', score: 5 }, { weaponId: 'a', score: 5 }, { weaponId: 'c', score: 1 }, { weaponId: 'd', score: 99 }, { weaponId: 'e' }], 3).map((x) => x.weaponId), ['c', 'a', 'b'])
})
test('qaTrend and qaAreaGrid', () => {
    const runs = [{ id: 1, game: 'g', kind: 'smoke', ranAt: '2026-11-22T01:00:00Z', ok: true }, { id: 2, game: 'g', kind: 'smoke', ranAt: '2026-11-22T02:00:00Z', ok: false }, { id: 3, game: 'h', kind: 'perf', ranAt: '2026-11-21T02:00:00Z', ok: true }]
    const t = qaTrend(runs, { days: 2, now: NOW })
    assert.deepEqual(t.map((x) => [x.pass, x.fail]), [[1, 0], [1, 1]])
    const g = qaAreaGrid(runs, { days: 2, now: NOW })
    assert.equal(g.rows.length, 2); assert.deepEqual(g.cols, ['2026-11-21', '2026-11-22'])
    const gs = g.rows.find((r) => r.game === 'g')
    assert.equal(gs.cells[0].rate, null); assert.equal(gs.cells[1].rate, 0.5); assert.equal(gs.cells[1].id, 2)
})
test('review helpers', () => {
    const rv = [{ key: 'a', title: 'A', game: 'g', counts: { total: 4, good: 1, wrong: 1, todo: 2 }, weapons: { w: { verdict: 'good', at: '2026-11-22T01:00:00Z', history: [{ verdict: 'wrong', at: '2026-11-21T01:00:00Z' }, { verdict: 'todo', at: '2026-11-21T02:00:00Z' }] } } }, { key: 'b', counts: { total: 0, good: 0, wrong: 0, todo: 0 } }]
    assert.deepEqual(verdictParts(rv).map((p) => p.value), [1, 1, 2])
    const p = reviewProgress(rv); assert.equal(p.length, 1); assert.equal(p[0].judged, 0.5)
    const v = verdictsByDay(rv, { days: 2, now: NOW }); assert.deepEqual(v.map((x) => [x.good, x.wrong]), [[0, 1], [1, 0]])
})
test('formatters and palette', () => {
    assert.equal(fmtMinutes(75), '1h 15m'); assert.equal(fmtMinutes(4.4), '4m'); assert.equal(fmtMinutes(null), '-')
    assert.equal(fmtUsd(1.234), '$1.23'); assert.equal(fmtUsd(undefined), '-')
    assert.equal(new Set(CAT).size, 4)
})
