// PERFORMANCE charts, the pure part: everything the interactive charts draw is shaped here (series, bands, deltas,
// regression reasons, summary cards, heatmap cells, histograms) so it can be tested with node --test and reused by any
// view that shows runs over time. No DOM, no database.
import { betterOf, median, unitOf } from './perf.mjs'

/** Chart sections, in page order. A metric not listed falls into "Other". */
export const SECTIONS = [
    { id: 'frame', title: 'Frame time', blurb: 'How long a frame takes to produce. Lower is smoother; the tail (p95, p99) is what players feel as stutter.', metrics: ['frame_ms', 'fps', 'frame_ms_avg', 'frame_ms_max'] },
    { id: 'tick', title: 'Network and ticks', blurb: 'Server simulation cost and the network it produces.', metrics: ['tick_ms', 'tick_ms_p95', 'dropped_ticks', 'net_rtt_ms', 'net_bytes_s', 'net_in_kbps', 'net_out_kbps'] },
    { id: 'render', title: 'Rendering', blurb: 'Work submitted to the GPU each frame.', metrics: ['draw_calls', 'primitives', 'render_cpu_ms', 'render_gpu_ms', 'nodes', 'objects', 'spikes'] },
    { id: 'memory', title: 'Memory', blurb: 'Resident and video memory. A steady climb across runs is a leak.', metrics: ['memory_mb', 'video_mb'] },
]
/** The percentile family drawn as one chart with bands. */
export const FRAME_PERCENTILES = ['frame_ms_p50', 'frame_ms_p95', 'frame_ms_p99']

export const INFO = {
    frame_ms: { title: 'Frame time percentiles', desc: 'Median (p50), 95th (p95) and 99th (p99) percentile of frame duration. The shaded bands show how far the slow frames stray from the typical one.', good: 'p95 under the frame budget and the bands narrow; 16.7 ms is 60 fps.', unit: 'ms' },
    fps: { title: 'Frames per second', desc: 'Average rendered frames per second over the run.', good: 'At or above the target (60 or more), steady between runs.' },
    frame_ms_avg: { title: 'Average frame time', desc: 'Mean frame duration. Hides stutter: compare it with p95.', good: 'Low and close to p50.' },
    frame_ms_max: { title: 'Worst frame', desc: 'The single slowest frame of the run. A one-off hitch (load, GC, shader compile) shows here first.', good: 'Under a few times the budget; isolated spikes are fine, a rising trend is not.' },
    tick_ms: { title: 'Server tick time', desc: 'Mean time to simulate one server tick.', good: 'Well under the tick interval (15.6 ms at 64 Hz).' },
    tick_ms_p95: { title: 'Server tick time p95', desc: 'The slow end of tick time. Ticks over the interval are dropped.', good: 'Under the tick interval.' },
    dropped_ticks: { title: 'Dropped ticks', desc: 'Server ticks that overran their slot and were skipped.', good: 'Zero.' },
    draw_calls: { title: 'Draw calls', desc: 'Draw calls issued per frame. Each costs CPU time, most of all in the browser.', good: 'Flat or falling; batching and instancing push it down.' },
    primitives: { title: 'Primitives', desc: 'Triangles and other primitives submitted per frame.', good: 'Flat or falling.' },
    memory_mb: { title: 'Memory', desc: 'Peak resident memory of the process.', good: 'Flat between runs; a steady rise is a leak.' },
    video_mb: { title: 'Video memory', desc: 'Textures, meshes and buffers resident on the GPU.', good: 'Under the card budget and flat.' },
    render_cpu_ms: { title: 'Render CPU time', desc: 'CPU time spent preparing the frame for the GPU.', good: 'Low; if it is above GPU time the CPU is the limit.' },
    render_gpu_ms: { title: 'Render GPU time', desc: 'GPU time to draw the frame.', good: 'Under the frame budget.' },
    net_bytes_s: { title: 'Network throughput', desc: 'Bytes per second on the wire.', good: 'Stable for the same bot count.' },
    net_rtt_ms: { title: 'Round trip time', desc: 'Latency to the server.', good: 'Low and steady.' },
    nodes: { title: 'Scene nodes', desc: 'Nodes alive in the scene tree.', good: 'Flat; growth between runs hints at leaked nodes.' },
    objects: { title: 'Objects', desc: 'Engine objects alive.', good: 'Flat.' },
    spikes: { title: 'Spikes', desc: 'Frames over the spike threshold.', good: 'Zero or few.' },
}
export const infoOf = (m) => INFO[m] ?? { title: m, desc: `Recorded value of ${m} per run.`, good: betterOf(m) === 'higher' ? 'Higher is better.' : 'Lower is better.' }
export const sectionOf = (m) => SECTIONS.find((s) => s.metrics.includes(m) || (s.id === 'frame' && FRAME_PERCENTILES.includes(m)))?.id ?? 'other'

/** Fixed colour-blind-safe categorical order (Okabe-Ito subset, readable on the dark panel). Colour follows the entity. */
export const PALETTE = { p50: '#56b4e9', p95: '#e69f00', p99: '#cc79a7', avg: '#009e73', max: '#d55e00', single: '#56b4e9' }
export const colorOf = (m) => (m.endsWith('_p50') ? PALETTE.p50 : m.endsWith('_p95') ? PALETTE.p95 : m.endsWith('_p99') ? PALETTE.p99 : m.endsWith('_max') ? PALETTE.max : m.endsWith('_avg') ? PALETTE.avg : PALETTE.single)

const fin = (v) => typeof v === 'number' && Number.isFinite(v)

/** Number with sensible precision and a unit. */
export function fmt(v, unit = '') {
    if (!fin(v)) return '-'
    const a = Math.abs(v)
    const s = Number.isInteger(v) ? String(v) : a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toFixed(3)
    return unit ? `${s} ${unit}` : s
}
export const fmtPct = (p) => (fin(p) ? `${p > 0 ? '+' : ''}${Math.abs(p) >= 10 ? p.toFixed(0) : p.toFixed(1)}%` : '-')

/** Budgets that apply to a run scope (a budget with no platform/role/map/bots applies to every run). */
export const budgetsFor = (budgets, metric, scope = {}) => budgets.filter((b) => b.metric === metric && (!b.platform || !scope.platform || b.platform === scope.platform) && (!b.role || !scope.role || b.role === scope.role) && (!b.map || b.map === scope.map) && (b.bots === undefined || b.bots === scope.bots))
export const limitOf = (b) => (b.max !== undefined ? b.max : b.min)

/** Points of one metric from runs [{id, ranAt, commit, label, build, platform, role, map, bots, metrics:{}}] oldest first. */
export function seriesOf(runs, metric) {
    const out = []
    for (const r of runs) {
        const v = r.metrics?.[metric]
        if (!fin(v)) continue
        out.push({ i: out.length, id: r.id, t: new Date(r.ranAt).getTime(), ranAt: r.ranAt, commit: r.commit ?? '', build: r.build ?? '', label: r.label ?? '', platform: r.platform, role: r.role, map: r.map, bots: r.bots, value: v })
    }
    return out
}

/** Trailing moving average (window n, n <= 1 returns the values unchanged). */
export function movingAverage(values, n) {
    if (!(n > 1)) return values.slice()
    return values.map((_, i) => { const w = values.slice(Math.max(0, i - n + 1), i + 1); return w.reduce((a, b) => a + b, 0) / w.length })
}

/** True when moving from `a` to `b` is an improvement for the metric. */
export const improved = (metric, a, b) => (betterOf(metric) === 'higher' ? b > a : b < a)

/** Per point: change vs the previous run (abs, pct, good) and distance to the budget (limit, kind, over, pct, ok). */
export function pointDeltas(points, metric, budgets = []) {
    return points.map((p, k) => {
        const prev = k > 0 ? points[k - 1] : null
        const delta = prev ? p.value - prev.value : null
        const pct = prev && prev.value !== 0 ? (delta / Math.abs(prev.value)) * 100 : null
        const b = budgetsFor(budgets, metric, p)[0]
        let budget = null
        if (b) {
            const limit = limitOf(b)
            const kind = b.max !== undefined ? 'max' : 'min'
            const over = kind === 'max' ? p.value - limit : limit - p.value
            budget = { limit, kind, over, pct: limit ? (over / Math.abs(limit)) * 100 : null, ok: over <= 0 }
        }
        return { delta, pct, good: delta === null || delta === 0 ? null : improved(metric, prev.value, p.value), prevId: prev?.id ?? null, budget }
    })
}

/** Regressions with a plain-language reason. Same rule as regressionMarkers in perf.mjs (worse than the median of the
 *  previous `window` points by more than noisePct), plus the budget it also breaks when it does. */
export function regressionReasons(points, metric, budgets = [], { window = 5, noisePct = 10 } = {}) {
    const out = []
    const unit = unitOf(metric)
    for (let i = 1; i < points.length; i++) {
        const prev = points.slice(Math.max(0, i - window), i)
        const base = median(prev.map((p) => p.value))
        if (!base) continue
        const pct = ((points[i].value - base) / Math.abs(base)) * 100
        const worse = betterOf(metric) === 'higher' ? pct < -noisePct : pct > noisePct
        if (!worse) continue
        const b = budgetsFor(budgets, metric, points[i])[0]
        const limit = b ? limitOf(b) : null
        const breach = b && (b.max !== undefined ? points[i].value > b.max : points[i].value < b.min)
        let reason = `${fmt(points[i].value, unit)} is ${Math.abs(pct).toFixed(0)}% worse than the median of the previous ${prev.length} run${prev.length === 1 ? '' : 's'} (${fmt(base, unit)}), past the ${noisePct}% noise band.`
        if (breach) reason += ` It also breaks the budget ${b.max !== undefined ? 'max' : 'min'} ${fmt(limit, unit)} by ${fmt(Math.abs(points[i].value - limit), unit)}.`
        out.push({ index: i, id: points[i].id, value: points[i].value, baseline: base, pct, budgetBreach: !!breach, reason })
    }
    return out
}

/** Y domain with padding. Log needs every value > 0 and otherwise falls back to linear. Non-negative data keeps 0 as the floor. */
export function yDomain(values, { log = false } = {}) {
    const v = values.filter(fin)
    if (!v.length) return { lo: 0, hi: 1, log: false }
    let lo = Math.min(...v), hi = Math.max(...v)
    if (log && lo > 0) return { lo: lo / 1.15, hi: hi * 1.15, log: true }
    const nonNeg = lo >= 0
    if (lo === hi) { const d = Math.abs(lo) * 0.1 || 1; lo -= d; hi += d }
    const pad = (hi - lo) * 0.1
    lo -= pad; hi += pad
    if (nonNeg && lo < 0) lo = 0
    return { lo, hi, log: false }
}

/** Round tick values inside [lo, hi], about `n` of them. */
export function niceTicks(lo, hi, n = 5) {
    const span = hi - lo
    if (!(span > 0)) return [lo]
    const raw = span / n
    const mag = 10 ** Math.floor(Math.log10(raw))
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
    const out = []
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toPrecision(12))
    return out
}
/** Log ticks: powers of ten and their 2x and 5x multiples inside the domain. */
export function logTicks(lo, hi) {
    const out = []
    for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) for (const m of [1, 2, 5]) { const v = m * 10 ** e; if (v >= lo && v <= hi) out.push(v) }
    return out
}

const DAY = 86_400_000
export function dateLabel(t, span = DAY * 30) {
    const d = new Date(t)
    const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]
    if (span < 2 * DAY) return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
    return `${M} ${d.getUTCDate()}`
}
export const dateFull = (t) => { const s = new Date(t).toISOString(); return `${s.slice(0, 10)} ${s.slice(11, 16)} UTC` }
/** Time ticks [{t, label}] across [t0, t1]: hours, days, weeks or months by span. Labels are UTC so every viewer agrees. */
export function timeTicks(t0, t1, n = 6) {
    const span = t1 - t0
    if (!(span > 0)) return [{ t: t0, label: dateLabel(t0, span) }]
    const steps = [3600e3, 6 * 3600e3, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 91 * DAY]
    const step = steps.find((s) => span / s <= n) ?? steps[steps.length - 1]
    const out = []
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) out.push({ t, label: dateLabel(t, span) })
    return out
}

/** Index of the point nearest to time t, or -1. */
export function nearest(points, t) {
    let best = -1, bd = Infinity
    for (let i = 0; i < points.length; i++) { const d = Math.abs(points[i].t - t); if (d < bd) { bd = d; best = i } }
    return best
}

/** Direction of the last `n` points: 'better' | 'worse' | 'flat' by the fitted slope relative to the mean, with a noise floor. */
export function trendOf(metric, values, { n = 8, floorPct = 2 } = {}) {
    const v = values.slice(-n)
    if (v.length < 3) return { dir: 'flat', pct: 0, enough: false }
    const mean = v.reduce((a, b) => a + b, 0) / v.length
    const xm = (v.length - 1) / 2
    let num = 0, den = 0
    v.forEach((y, x) => { num += (x - xm) * (y - mean); den += (x - xm) ** 2 })
    const slope = den ? num / den : 0
    const pct = mean ? ((slope * (v.length - 1)) / Math.abs(mean)) * 100 : 0
    if (Math.abs(pct) < floorPct) return { dir: 'flat', pct, enough: true }
    return { dir: (betterOf(metric) === 'higher' ? pct > 0 : pct < 0) ? 'better' : 'worse', pct, enough: true }
}

/** Why a chart cannot say much: null when the data is enough to draw a trend line. */
export function lowData(points) {
    if (points.length === 0) return 'No runs recorded this metric in this scope.'
    if (points.length === 1) return `Only one run has recorded this metric, so there is no trend yet (value ${fmt(points[0].value)}). A line needs two runs or more.`
    if (points.length === 2) return 'Only two runs so far: the line is drawn, but regressions need at least three runs of history.'
    return null
}

/** Summary of one metric for the status cards. */
export function summarise(runs, metric, budgets = []) {
    const pts = seriesOf(runs, metric)
    const last = pts[pts.length - 1]
    if (!last) return null
    const d = pointDeltas(pts, metric, budgets)[pts.length - 1]
    return { metric, latest: last.value, id: last.id, count: pts.length, delta: d.delta, pct: d.pct, good: d.good, budget: d.budget, trend: trendOf(metric, pts.map((p) => p.value)), spark: pts.slice(-30).map((p) => p.value), reasons: regressionReasons(pts, metric, budgets) }
}

/** Header cards: budgets pass/fail, latest fps, worst metric, regression count over the newest `recent` runs. */
export function statusCards(runs, metrics, budgets = [], { recent = 10 } = {}) {
    const sums = metrics.map((m) => summarise(runs, m, budgets)).filter(Boolean)
    const checked = sums.filter((s) => s.budget)
    const failing = checked.filter((s) => !s.budget.ok)
    const ids = new Set(runs.slice(-recent).map((r) => r.id))
    const regs = sums.flatMap((s) => s.reasons.filter((r) => ids.has(r.id)).map((r) => ({ metric: s.metric, ...r })))
    const newest = runs[runs.length - 1]?.id
    const worst = regs.filter((r) => r.id === newest).sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))[0]
        ?? failing.slice().sort((a, b) => (b.budget.pct ?? 0) - (a.budget.pct ?? 0)).map((s) => ({ metric: s.metric, pct: s.budget.pct, reason: `over its budget by ${fmtPct(s.budget.pct)}` }))[0] ?? null
    return { sums, budgets: { checked: checked.length, failing: failing.map((s) => s.metric), pass: checked.length > 0 && failing.length === 0 }, fps: sums.find((s) => s.metric === 'fps') ?? null, worst, regressions: regs.length, regressionRuns: new Set(regs.map((r) => r.id)).size }
}

/** Heatmap metric x run: cell z = percent worse (positive) or better (negative) than the median of the previous `window`
 *  runs, direction-aware; `flag` marks regressions. No baseline: z = null. */
export function heatmap(runs, metrics, { window = 5, noisePct = 10, last = 40 } = {}) {
    const slice = runs.slice(-last)
    const rows = metrics.map((metric) => {
        const pts = seriesOf(runs, metric)
        const byId = new Map(pts.map((p, k) => [p.id, k]))
        const cells = slice.map((r) => {
            const k = byId.get(r.id)
            if (k === undefined) return { id: r.id, z: null, value: null, flag: false }
            const prev = pts.slice(Math.max(0, k - window), k)
            const base = prev.length ? median(prev.map((p) => p.value)) : NaN
            if (!base) return { id: r.id, z: null, value: pts[k].value, flag: false }
            const raw = ((pts[k].value - base) / Math.abs(base)) * 100
            const z = betterOf(metric) === 'higher' ? -raw : raw
            return { id: r.id, z, value: pts[k].value, base, flag: z > noisePct }
        })
        return { metric, cells }
    })
    return { runs: slice, rows }
}

/** Histogram of values: {bins:[{lo,hi,n}], max}. */
export function histogram(values, bins = 12) {
    const v = values.filter(fin)
    if (!v.length) return { bins: [], max: 0 }
    const lo = Math.min(...v), hi = Math.max(...v)
    const w = (hi - lo) / bins || 1
    const out = Array.from({ length: bins }, (_, i) => ({ lo: lo + i * w, hi: lo + (i + 1) * w, n: 0 }))
    for (const x of v) out[Math.min(bins - 1, Math.floor((x - lo) / w))].n++
    return { bins: out, max: Math.max(...out.map((b) => b.n)) }
}

/** Diff table of two runs' metrics with budget verdicts; `noisePct` is the band treated as unchanged. */
export function diffRuns(a, b, budgets = [], { noisePct = 5 } = {}) {
    const names = [...new Set([...Object.keys(a.metrics ?? {}), ...Object.keys(b.metrics ?? {})])].sort()
    return names.map((metric) => {
        const av = a.metrics?.[metric], bv = b.metrics?.[metric]
        if (!fin(av) || !fin(bv)) return { metric, a: av, b: bv, delta: null, pct: null, verdict: fin(bv) ? 'new' : 'gone', budget: null }
        const delta = bv - av
        const pct = av ? (delta / Math.abs(av)) * 100 : null
        const verdict = pct !== null && Math.abs(pct) <= noisePct ? 'same' : improved(metric, av, bv) ? 'better' : 'worse'
        const bud = budgetsFor(budgets, metric, b)[0]
        const budget = bud ? { limit: limitOf(bud), kind: bud.max !== undefined ? 'max' : 'min', ok: bud.max !== undefined ? bv <= bud.max : bv >= bud.min } : null
        return { metric, a: av, b: bv, delta, pct, verdict, budget }
    })
}

/** Worst offenders strip: metrics ranked by how far the newest run is past its budget or baseline. */
export function worstMetrics(cards, top = 4) {
    return cards.sums.map((s) => {
        const reg = s.reasons.find((r) => r.id === s.id)
        const score = Math.max(s.budget && !s.budget.ok ? s.budget.pct ?? 0 : 0, reg ? Math.abs(reg.pct) : 0)
        return { metric: s.metric, score, value: s.latest, budget: s.budget, reason: reg?.reason ?? (s.budget && !s.budget.ok ? `over budget by ${fmtPct(s.budget.pct)}` : '') }
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, top)
}
