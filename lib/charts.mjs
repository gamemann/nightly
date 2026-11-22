// Data shaping for the dashboard charts outside Performance (Runs, Schedules, QA, Assets, Reviews, Settings, home).
// Pure functions: no DOM, no database, so node --test covers them. The drawing lives in src/components/Charts.tsx.
import { median } from './perf.mjs'

const DAY = 86_400_000

/** Colour-blind-safe categorical palette for the dark panel, fixed order. Checked with the dataviz validator
 *  (`validate_palette.js "<hexes>" --mode dark --surface "#111217"`): lightness band, chroma, CVD and normal-vision
 *  separation of adjacent slots and 3:1 contrast all pass. State is never colour alone: legends, tooltips and labels
 *  carry the words. Adjacent order matters (red/blue/amber/green): do not reorder. */
export const CAT = ['#e0524d', '#3f93cc', '#bf8300', '#009e73']
export const COLOR = { bad: CAT[0], info: CAT[1], warn: CAT[2], good: CAT[3], none: '#6b7080', seq: CAT[1] }
/** Run and QA states in stacking order (bottom first). */
export const RUN_STATES = [
    { key: 'ok', label: 'ok', color: COLOR.good },
    { key: 'findings', label: 'findings', color: COLOR.warn },
    { key: 'failed', label: 'failed', color: COLOR.bad },
    { key: 'running', label: 'running', color: COLOR.info },
    { key: 'skipped', label: 'skipped', color: COLOR.none },
]
export const stateOf = (status) => (RUN_STATES.some((s) => s.key === status) ? status : 'skipped')

const ms = (d) => (d instanceof Date ? d.getTime() : typeof d === 'number' ? d : Date.parse(d))
/** UTC midnight of a timestamp. */
export const dayStart = (t) => Math.floor(ms(t) / DAY) * DAY
export const dayKey = (t) => new Date(ms(t)).toISOString().slice(0, 10)

/** Runs per UTC day for the last `days` days ending at `now`, one bar per day (empty days included), segments by status.
 *  runs: [{ id, startedAt, status }]. Returns [{ key, t, total, segments:{ok,findings,...}, ids:[] }] oldest first. */
export function statusByDay(runs, { days = 30, now = Date.now() } = {}) {
    const end = dayStart(now)
    const out = []
    const idx = new Map()
    for (let i = days - 1; i >= 0; i--) {
        const t = end - i * DAY
        const b = { key: dayKey(t), t, total: 0, segments: Object.fromEntries(RUN_STATES.map((s) => [s.key, 0])), ids: [] }
        idx.set(b.key, b); out.push(b)
    }
    for (const r of runs) {
        const b = idx.get(dayKey(r.startedAt))
        if (!b) continue
        b.segments[stateOf(r.status)]++; b.total++; b.ids.push(r.id)
    }
    return out
}

/** Share of finished runs that completed (ok or findings; failed and skipped do not). null with no finished run. */
export function successRate(runs) {
    const done = runs.filter((r) => r.status !== 'running')
    if (!done.length) return null
    return done.filter((r) => r.status === 'ok' || r.status === 'findings').length / done.length
}

/** Value series (oldest first) of a numeric run field, skipping runs without it: for duration and cost sparklines. */
export function runSeries(runs, field, { last = 30 } = {}) {
    return [...runs].sort((a, b) => ms(a.startedAt) - ms(b.startedAt) || a.id - b.id)
        .filter((r) => typeof r[field] === 'number' && Number.isFinite(r[field]))
        .slice(-last).map((r) => ({ id: r.id, t: ms(r.startedAt), v: r[field] }))
}

/** Weekday (Mon first) by hour counts of when runs start, UTC unless `offsetMin` shifts it. Returns { grid: number[7][24], max, total }. */
export function startHeat(times, { offsetMin = 0 } = {}) {
    const grid = Array.from({ length: 7 }, () => Array(24).fill(0))
    let max = 0, total = 0
    for (const x of times) {
        const t = ms(x)
        if (!Number.isFinite(t)) continue
        const d = new Date(t + offsetMin * 60_000)
        const v = ++grid[(d.getUTCDay() + 6) % 7][d.getUTCHours()]
        if (v > max) max = v
        total++
    }
    return { grid, max, total }
}

/** Per-schedule rows: run count, success rate, rolling success sparkline values, status strip, median minutes.
 *  runs: [{ id, startedAt, status, minutes, schedule:{id,name}|null }] in any order. */
export function perSchedule(runs, { last = 20 } = {}) {
    const by = new Map()
    for (const r of [...runs].sort((a, b) => ms(a.startedAt) - ms(b.startedAt) || a.id - b.id)) {
        const k = r.schedule?.id ?? 'none'
        if (!by.has(k)) by.set(k, { id: r.schedule?.id ?? null, name: r.schedule?.name ?? 'no schedule', runs: [] })
        by.get(k).runs.push(r)
    }
    return [...by.values()].map((s) => {
        const rs = s.runs.slice(-last)
        const roll = rs.map((_, i) => successRate(rs.slice(Math.max(0, i - 4), i + 1))).filter((v) => v !== null).map((v) => Math.round(v * 100))
        const mins = rs.map((r) => r.minutes).filter((v) => typeof v === 'number')
        return { id: s.id, name: s.name, total: s.runs.length, rate: successRate(rs), roll, strip: rs.map((r) => ({ id: r.id, state: stateOf(r.status) })), medianMinutes: mins.length ? median(mins) : null }
    })
}

/** Upcoming fires merged across schedules, soonest first, with hour offset from `now`. Drops past fires and those beyond `hours`.
 *  fires: [{ scheduleId, name, at (ISO or ms) }]. */
export function timelineOf(fires, { now = Date.now(), hours = 48 } = {}) {
    return fires.map((f) => ({ ...f, t: ms(f.at) })).filter((f) => f.t >= now && f.t <= now + hours * 3_600_000)
        .sort((a, b) => a.t - b.t || a.name.localeCompare(b.name)).map((f) => ({ ...f, inHours: (f.t - now) / 3_600_000 }))
}

/** Score distribution: fixed-width bins over 0..100 with tier (fail < 40, warn < 70, pass). rows: [{ score }]. */
export function scoreBins(rows, { width = 10 } = {}) {
    const n = Math.ceil(100 / width)
    const bins = Array.from({ length: n }, (_, i) => {
        const lo = i * width, hi = i === n - 1 ? 100 : lo + width - 1
        return { lo, hi, label: `${lo}-${hi}`, count: 0, tier: lo >= 70 ? 'pass' : lo >= 40 ? 'warn' : 'fail' }
    })
    for (const r of rows) {
        if (typeof r.score !== 'number' || !Number.isFinite(r.score)) continue
        bins[Math.min(n - 1, Math.max(0, Math.floor(r.score / width)))].count++
    }
    return bins
}

/** Pass share per group: rows [{ score, pass }] grouped by `by(row)` (a key or array of keys). Weakest first. */
export function passByGroup(rows, by) {
    const g = new Map()
    for (const r of rows) {
        const keys = by(r)
        for (const k of Array.isArray(keys) ? keys : [keys]) {
            if (!k) continue
            const x = g.get(k) ?? { key: k, total: 0, pass: 0, sum: 0 }
            x.total++; if (r.pass) x.pass++; x.sum += r.score ?? 0
            g.set(k, x)
        }
    }
    return [...g.values()].map((x) => ({ key: x.key, total: x.total, pass: x.pass, rate: x.pass / x.total, mean: x.sum / x.total }))
        .sort((a, b) => a.rate - b.rate || b.total - a.total || a.key.localeCompare(b.key))
}

/** Count of assets carrying each flag code (one tab when `tab` is given), most common first. */
export function flagCounts(rows, tab) {
    const c = new Map()
    for (const r of rows) for (const f of r.flags ?? []) if (!tab || f.tab === tab) c.set(f.code, { code: f.code, severity: f.severity, n: (c.get(f.code)?.n ?? 0) + 1 })
    return [...c.values()].sort((a, b) => b.n - a.n || a.code.localeCompare(b.code))
}

/** Lowest-scoring rows first. */
export const worstOffenders = (rows, n = 8) => rows.filter((r) => typeof r.score === 'number')
    .sort((a, b) => a.score - b.score || String(a.weaponId).localeCompare(String(b.weaponId))).slice(0, n)

/** QA runs as pass/fail counts per UTC day: [{ key, t, total, pass, fail, ids }]. runs: [{ id, ranAt, ok }]. */
export function qaTrend(runs, { days = 30, now = Date.now() } = {}) {
    const end = dayStart(now)
    return Array.from({ length: days }, (_, i) => {
        const t = end - (days - 1 - i) * DAY
        const k = dayKey(t)
        const day = runs.filter((r) => dayKey(r.ranAt) === k)
        const pass = day.filter((r) => r.ok).length
        return { key: k, t, total: day.length, pass, fail: day.length - pass, ids: day.map((r) => r.id) }
    })
}

/** QA heatmap: one row per game and kind, one column per UTC day; cell = pass share that day, null when nothing ran.
 *  runs: [{ id, game, kind, ranAt, ok }]. */
export function qaAreaGrid(runs, { days = 14, now = Date.now() } = {}) {
    const end = dayStart(now)
    const cols = Array.from({ length: days }, (_, i) => dayKey(end - (days - 1 - i) * DAY))
    const keys = [...new Set(runs.map((r) => `${r.game}\u0000${r.kind}`))].sort()
    return {
        cols,
        rows: keys.map((k) => {
            const [game, kind] = k.split('\u0000')
            const mine = runs.filter((r) => r.game === game && r.kind === kind)
            return {
                key: k, game, kind,
                cells: cols.map((c) => {
                    const day = mine.filter((r) => dayKey(r.ranAt) === c)
                    const pass = day.filter((r) => r.ok).length
                    return { key: c, total: day.length, pass, rate: day.length ? pass / day.length : null, id: [...day].sort((a, b) => ms(b.ranAt) - ms(a.ranAt))[0]?.id }
                }),
            }
        }),
    }
}

/** Review counts by verdict summed across reviews. */
export function verdictParts(reviews) {
    const s = (f) => reviews.reduce((n, r) => n + f(r.counts), 0)
    return [{ key: 'good', label: 'good', value: s((c) => c.good) }, { key: 'wrong', label: 'still wrong', value: s((c) => c.wrong) }, { key: 'todo', label: 'not reviewed', value: s((c) => c.todo) }]
}

/** Review progress rows, least judged first (reviews without weapons dropped). */
export function reviewProgress(reviews) {
    return reviews.filter((r) => r.counts.total > 0)
        .map((r) => ({ key: r.key, title: r.title, game: r.game, total: r.counts.total, good: r.counts.good, wrong: r.counts.wrong, todo: r.counts.todo, judged: (r.counts.good + r.counts.wrong) / r.counts.total }))
        .sort((a, b) => a.judged - b.judged || b.total - a.total || String(a.key).localeCompare(String(b.key)))
}

/** Verdicts per day from history plus current verdicts: [{ key, t, good, wrong }]. */
export function verdictsByDay(reviews, { days = 30, now = Date.now() } = {}) {
    const end = dayStart(now)
    const out = Array.from({ length: days }, (_, i) => ({ key: dayKey(end - (days - 1 - i) * DAY), t: end - (days - 1 - i) * DAY, good: 0, wrong: 0 }))
    const idx = new Map(out.map((o) => [o.key, o]))
    for (const r of reviews) for (const w of Object.values(r.weapons ?? {})) for (const v of [...(w.history ?? []), { verdict: w.verdict, at: w.at }]) {
        if (!v.at || (v.verdict !== 'good' && v.verdict !== 'wrong')) continue
        const b = idx.get(dayKey(v.at))
        if (b) b[v.verdict]++
    }
    return out
}

export const fmtMinutes = (m) => (m == null || !Number.isFinite(m) ? '-' : m >= 60 ? `${Math.floor(m / 60)}h ${Math.round(m % 60)}m` : `${Math.round(m)}m`)
export const fmtUsd = (c) => (c == null || !Number.isFinite(c) ? '-' : `$${c.toFixed(2)}`)
