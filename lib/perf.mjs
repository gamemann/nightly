// PERFORMANCE tab, the pure part: parse a profiler report, derive metrics, compare two runs, check budgets.
// No database and no I/O here (both the CLI and the tests use it; the panel only reads what the CLI stored).
// Input: the versioned dot-profiler report JSON (docs/report-format.md; v1 and v2 both read, unknown keys ignored),
// its .folded stacks, its .txt summary, or the older perf_bench JSON ("bench") -- missing keys are skipped, never fatal.

export const PLATFORMS = ['native', 'web']
export const ROLES = ['client', 'server']

/** Metric catalogue: unit and direction. Unknown names are allowed (lower is better unless listed). */
export const METRICS = {
    fps: { unit: 'fps', better: 'higher' },
    frame_ms_avg: { unit: 'ms' }, frame_ms_p50: { unit: 'ms' }, frame_ms_p95: { unit: 'ms' }, frame_ms_p99: { unit: 'ms' }, frame_ms_max: { unit: 'ms' },
    tick_ms: { unit: 'ms' }, tick_ms_p95: { unit: 'ms' }, dropped_ticks: { unit: 'ticks' },
    draw_calls: { unit: 'calls' }, primitives: { unit: '' }, nodes: { unit: '' }, objects: { unit: '' },
    memory_mb: { unit: 'MB' }, video_mb: { unit: 'MB' }, render_cpu_ms: { unit: 'ms' }, render_gpu_ms: { unit: 'ms' },
    net_bytes_s: { unit: 'B/s' }, net_rtt_ms: { unit: 'ms' }, spikes: { unit: 'frames' },
}
export const betterOf = (m) => METRICS[m]?.better ?? 'lower'
export const unitOf = (m) => METRICS[m]?.unit ?? ''

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v))
const at = (o, ...ks) => ks.reduce((a, k) => (a && typeof a === 'object' ? a[k] : undefined), o)
const put = (m, k, v) => { v = num(v); if (v !== undefined) m[k] = v }

/** Budget group of a span path: the engine phase it runs under. */
export function groupOf(p) {
    const s = String(p || '').split(';')
    const root = s[0] === 'frame' ? s[1] : s[0]
    return ['physics', 'process', 'render', 'wait'].includes(root) ? root : 'other'
}

/** Attribution of a span name to an addon: the game's prefix map (longest prefix wins), else the name up to its first "."/"_"/":". */
export function addonOf(name, map = {}) {
    let best = ''
    for (const k of Object.keys(map)) if (name.startsWith(k) && k.length > best.length) best = k
    if (best) return map[best]
    const m = /^([A-Za-z0-9]+)[._:]/.exec(name)
    return m ? m[1] : ''
}

/** Parse `.folded` text ("a;b;c 1234" per line, microseconds). Throws on a line that is not that. */
export function parseFolded(text) {
    const rows = []
    const lines = String(text).split('\n')
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i].trim()
        if (!l || l.startsWith('#')) continue
        const m = /^(.*\S)\s+(\d+(?:\.\d+)?)$/.exec(l)
        if (!m) throw new Error(`folded line ${i + 1} is not "stack count": ${l.slice(0, 60)}`)
        rows.push({ stack: m[1], value: Number(m[2]) })
    }
    if (!rows.length) throw new Error('folded stacks: no lines')
    return rows
}

/** Per-function rows from folded stacks: self time per leaf frame name (the last path element), in ms total. */
export function functionsFromFolded(rows, addons = {}) {
    const by = new Map()
    for (const r of rows) {
        const parts = r.stack.split(';')
        const name = parts[parts.length - 1]
        const e = by.get(name) ?? { name, path: r.stack, per: 'frame', selfMs: 0, totalMs: 0, calls: 0, best: 0 }
        e.selfMs += r.value / 1000
        if (r.value > e.best) { e.best = r.value; e.path = r.stack }
        by.set(name, e)
    }
    for (const r of rows) for (const n of new Set(r.stack.split(';').slice(0, -1))) { const e = by.get(n); if (e) e.totalMs += r.value / 1000 }
    return [...by.values()].map(({ best, ...e }) => ({ ...e, totalMs: Math.max(e.totalMs + e.selfMs, e.selfMs), grp: groupOf(e.path), addon: addonOf(e.name, addons) }))
        .sort((a, b) => b.selfMs - a.selfMs)
}

/** The human text report: only its headline numbers (frames, percentiles, GPU, scene). */
export function parseTxt(text) {
    const metrics = {}
    const run = {}
    const h = /frames=(\d+) over ([\d.]+) s\s+p50=([\d.]+) p95=([\d.]+) p99=([\d.]+) worst=([\d.]+) ms(?:\s+budget=([\d.]+) ms)?(?:\s+spikes=(\d+))?/.exec(text)
    if (!h) throw new Error('text report: no "frames=N over S s p50=.. p95=.. p99=.. worst=.." headline')
    run.frames = +h[1]; run.durationS = +h[2]
    put(metrics, 'frame_ms_p50', +h[3]); put(metrics, 'frame_ms_p95', +h[4]); put(metrics, 'frame_ms_p99', +h[5]); put(metrics, 'frame_ms_max', +h[6])
    if (h[8]) put(metrics, 'spikes', +h[8])
    if (run.durationS > 0) put(metrics, 'fps', run.frames / run.durationS)
    const sc = /^dot-profiler report \S+\s+scene=(\S+)/m.exec(text)
    if (sc) run.map = sceneName(sc[1])
    const g = /GPU ([^,;]+)/.exec(text)
    if (g) run.gpu = g[1].trim()
    const w = /window (\d+x\d+)/.exec(text)
    if (w) run.resolution = w[1]
    return { kind: 'txt', run, metrics, functions: [] }
}

const sceneName = (s) => String(s || '').replace(/^res:\/\//, '').replace(/\.tscn$/, '').replace(/^.*\//, '')

/** Older perf_bench JSON ({frame_ms:{avg,fps,p50..}, per_frame:{draw_calls..}, bots, map}). */
function parseBench(j) {
    const metrics = {}
    const f = j.frame_ms ?? {}
    put(metrics, 'fps', f.fps); put(metrics, 'frame_ms_avg', f.avg); put(metrics, 'frame_ms_p50', f.p50); put(metrics, 'frame_ms_p95', f.p95)
    put(metrics, 'frame_ms_p99', f.p99); put(metrics, 'frame_ms_max', f.max)
    const pf = j.per_frame ?? {}
    for (const k of ['draw_calls', 'primitives', 'nodes', 'objects', 'render_cpu_ms', 'render_gpu_ms']) put(metrics, k, pf[k])
    put(metrics, 'dropped_ticks', j.dropped_ticks)
    const run = { map: str(j.map), bots: num(j.bots) ?? 0, gpu: str(j.adapter), durationS: num(j.wall_s) ?? num(j.seconds) ?? 0, frames: num(j.frames) ?? 0,
        resolution: str(j.window), name: str(j.tag), platform: 'native', role: 'client' }
    return { kind: 'bench', run, metrics, functions: [] }
}

/** The dot-profiler perf-report v1 envelope (schema "gamespice.perf-report", docs/perf-report.schema.json in dot-profiler). */
function parseV1(j, { addons = {}, topFunctions = 300 } = {}) {
    const metrics = {}
    const fm = at(j, 'frame', 'ms') ?? {}
    put(metrics, 'frame_ms_p50', fm.p50); put(metrics, 'frame_ms_p95', fm.p95); put(metrics, 'frame_ms_p99', fm.p99)
    put(metrics, 'frame_ms_max', fm.max); put(metrics, 'frame_ms_avg', fm.avg)
    put(metrics, 'fps', at(j, 'frame', 'fps_avg') ?? (fm.avg > 0 ? 1000 / fm.avg : undefined))
    put(metrics, 'spikes', at(j, 'frame', 'over_budget'))
    put(metrics, 'tick_ms', at(j, 'tick', 'ms', 'avg')); put(metrics, 'dropped_ticks', at(j, 'tick', 'dropped'))
    const r = j.render ?? {}
    put(metrics, 'draw_calls', at(r, 'draw_calls', 'avg')); put(metrics, 'primitives', at(r, 'primitives', 'avg')); put(metrics, 'objects', at(r, 'objects', 'avg'))
    put(metrics, 'video_mb', r.video_mb)
    const m = j.memory ?? {}
    put(metrics, 'memory_mb', at(m, 'static_mb', 'end') ?? at(m, 'static_mb', 'peak')); put(metrics, 'nodes', at(m, 'nodes', 'end'))
    put(metrics, 'render_cpu_ms', at(j, 'frame', 'render_cpu_ms', 'avg')); put(metrics, 'render_gpu_ms', at(j, 'frame', 'render_gpu_ms', 'avg'))
    put(metrics, 'net_in_kbps', at(j, 'network', 'in_kbps', 'avg')); put(metrics, 'net_out_kbps', at(j, 'network', 'out_kbps', 'avg'))
    const b = j.build ?? {}
    const run = {
        game: str(j.game_id), commit: str(b.commit && b.commit !== 'unknown' ? b.commit : ''), branch: str(b.branch), build: str(b.version),
        platform: j.platform, role: j.role === 'standalone' ? 'client' : j.role, map: str(j.map || sceneName(j.scene)), bots: num(j.bots) ?? 0,
        resolution: str(j.resolution), gpu: str(j.gpu), durationS: num(j.duration_s) ?? 0, frames: num(at(j, 'frame', 'count')) ?? 0,
        ranAt: str(j.made_utc), reportVersion: 1, name: str(at(j, 'tags', 'name')),
    }
    for (const k of Object.keys(run)) if (run[k] === '' || run[k] === undefined) delete run[k]
    const tops = at(j, 'script', 'top_functions')
    const fromTop = (Array.isArray(tops) ? tops : []).map((f) => ({ name: str(f.name), path: str(f.path), per: 'frame', grp: groupOf(str(f.path)), addon: addonOf(str(f.name), addons),
        selfMs: num(f.self_ms_per_frame) ?? 0, totalMs: num(f.total_ms_per_frame) ?? 0, calls: num(f.calls_per_frame) ?? 0 }))
    const fromBudget = (Array.isArray(j.budget) ? j.budget : []).map((f) => ({ name: str(f.id), path: str(f.id).replace(/\./g, ';'), per: f.per === 'tick' ? 'tick' : 'frame', grp: str(f.id).split('.')[0] || 'other',
        addon: str(f.addon) === 'game' ? '' : str(f.addon), selfMs: num(f.self_ms_per_frame) ?? num(f.ms_per_frame) ?? 0, totalMs: num(f.ms_per_frame) ?? 0, calls: num(f.calls_per_frame) ?? 0 }))
    const functions = (fromTop.length ? fromTop : fromBudget).filter((f) => f.name).sort((a, b) => b.selfMs - a.selfMs)
    return { kind: 'json', run, metrics, functions: topFunctions > 0 ? functions.slice(0, topFunctions) : functions }
}

/** Parse a report JSON object (profiler v1/v2, bench, or an object with a top-level `run`/`meta` envelope). */
export function parseReportJson(j, { addons = {}, topFunctions = 300 } = {}) {
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('report JSON must be an object')
    if (j.schema === 'gamespice.perf-report') return parseV1(j, { addons, topFunctions })
    if (j.frame_ms && typeof j.frame_ms === 'object' && !('frames' in j && 'p50_ms' in j)) return parseBench(j)
    const known = ['p50_ms', 'frames', 'frame_stats', 'monitors', 'tree', 'functions', 'systems', 'metrics']
    if (!known.some((k) => k in j)) throw new Error('not a profiler report: none of ' + known.join(', ') + ' present')
    const metrics = {}
    const fs = j.frame_stats ?? {}
    put(metrics, 'frame_ms_p50', j.p50_ms ?? at(fs, 'frame', 'p50')); put(metrics, 'frame_ms_p95', j.p95_ms ?? at(fs, 'frame', 'p95'))
    put(metrics, 'frame_ms_p99', j.p99_ms ?? at(fs, 'frame', 'p99')); put(metrics, 'frame_ms_max', j.worst_ms ?? at(fs, 'frame', 'max'))
    put(metrics, 'frame_ms_avg', at(fs, 'frame', 'avg'))
    const wall = num(j.wall_s) ?? num(j.seconds)
    if (num(j.frames) && wall > 0) put(metrics, 'fps', j.frames / wall)
    else if (metrics.frame_ms_avg > 0) put(metrics, 'fps', 1000 / metrics.frame_ms_avg)
    put(metrics, 'spikes', j.spike_count)
    const tpf = num(at(j, 'physics_ticks', 'per_frame'))
    if (num(at(fs, 'physics', 'avg')) !== undefined && tpf > 0) put(metrics, 'tick_ms', fs.physics.avg / tpf)
    else put(metrics, 'tick_ms', at(j, 'budget', 'sim_ms_per_tick'))
    put(metrics, 'dropped_ticks', at(j, 'physics_ticks', 'dropped_ticks'))
    const mon = j.monitors ?? {}
    put(metrics, 'draw_calls', at(mon, 'draw_calls', 'avg')); put(metrics, 'primitives', at(mon, 'primitives', 'avg'))
    put(metrics, 'nodes', at(mon, 'nodes', 'avg')); put(metrics, 'objects', at(mon, 'objects', 'avg'))
    put(metrics, 'memory_mb', at(mon, 'static_mb', 'avg')); put(metrics, 'video_mb', at(mon, 'video_mb', 'avg'))
    put(metrics, 'render_cpu_ms', at(mon, 'render_cpu_ms', 'avg')); put(metrics, 'render_gpu_ms', at(mon, 'render_gpu_ms', 'avg'))
    const net = at(j, 'context', 'net') ?? {}
    put(metrics, 'net_rtt_ms', net.rtt_ms); put(metrics, 'net_bytes_s', net.bytes_per_s ?? net.bytes_s)
    if (j.metrics && typeof j.metrics === 'object') for (const [k, v] of Object.entries(j.metrics)) put(metrics, k, typeof v === 'object' ? v?.value : v)

    const ctx = j.context ?? {}
    const mach = ctx.machine ?? {}
    const game = ctx.game ?? {}
    const env = { ...(j.run ?? {}), ...(j.meta ?? {}), ...(ctx.run ?? {}) }
    const build = ctx.build ?? {}
    const commit = str(env.commit || (build.commit && build.commit !== 'unknown' ? build.commit : ''))
    const run = {
        game: str(env.game), name: str(env.name), commit, build: str(env.build || [build.name, build.version].filter(Boolean).join(' ')),
        branch: str(env.branch || build.branch), platform: str(env.platform), role: str(env.role),
        map: str(env.map || game.map || sceneName(j.scene)), bots: num(env.bots) ?? num(game.bots) ?? 0,
        resolution: str(env.resolution || mach.window), gpu: str(env.gpu || mach.gpu), durationS: wall ?? 0, frames: num(j.frames) ?? 0,
        ranAt: str(env.ranAt || j.made), reportVersion: num(j.version) ?? 0,
    }
    if (!run.platform) run.platform = /web/i.test(str(mach.display) + str(mach.os)) ? 'web' : 'native'
    for (const k of Object.keys(run)) if (run[k] === '' || run[k] === undefined) delete run[k]

    // Profiler table: `functions` (every span by name) is the full table; older reports only have `systems`.
    const src = Array.isArray(j.functions) && j.functions.length ? j.functions : Array.isArray(j.systems) ? j.systems : []
    const functions = src.map((f) => {
        const name = str(f.name ?? f.system)
        const path = str(f.path)
        const per = f.per === 'tick' ? 'tick' : 'frame'
        return {
            name, path, per, grp: groupOf(path), addon: addonOf(name, addons),
            selfMs: num(f.self_ms_per_frame) ?? num(f.ms_per_frame) ?? num(f.self_ms) ?? 0,
            totalMs: num(f.total_ms_per_frame) ?? num(f.ms_per_frame) ?? num(f.total_ms) ?? 0,
            calls: num(f.calls) ?? num(f.calls_per_frame) ?? 0,
        }
    }).filter((f) => f.name).sort((a, b) => b.selfMs - a.selfMs)
    return { kind: 'json', run, metrics, functions: topFunctions > 0 ? functions.slice(0, topFunctions) : functions }
}

/** Parse whatever was handed over: by file name when it has one, else by content. */
export function parseAny(text, name = '', opts = {}) {
    const ext = (/\.(\w+)$/.exec(name)?.[1] ?? '').toLowerCase()
    const t = String(text)
    const head = t.trimStart()[0]
    if (ext === 'folded' || (ext !== 'json' && ext !== 'txt' && head !== '{' && /^\S.*\s\d+\s*$/m.test(t.split('\n')[0] ?? '') && !t.startsWith('dot-profiler'))) {
        const rows = parseFolded(t)
        return { kind: 'folded', run: {}, metrics: {}, functions: functionsFromFolded(rows, opts.addons).slice(0, opts.topFunctions || 300), folded: t }
    }
    if (ext === 'txt' || t.startsWith('dot-profiler report')) return { ...parseTxt(t), text: t }
    let j
    try { j = JSON.parse(t) } catch (e) { throw new Error(`${name || 'input'}: not JSON, folded stacks or a profiler text report (${e.message})`) }
    return parseReportJson(j, opts)
}

// ---------- budgets ----------

/** "frame_ms_p95<=33", "fps>=60@platform=native,role=client,map=arena,bots=4" -> budget object. Throws on nonsense. */
export function parseBudgetSpec(spec) {
    const [cond, scope = ''] = String(spec).split('@')
    const m = /^\s*([\w.]+)\s*(<=|>=|<|>)\s*(-?\d+(?:\.\d+)?)\s*$/.exec(cond)
    if (!m) throw new Error(`budget "${spec}": want metric<=value or metric>=value, optionally @platform=..,role=..,map=..,bots=..`)
    const b = { metric: m[1] }
    b[m[2][0] === '<' ? 'max' : 'min'] = Number(m[3])
    for (const kv of scope.split(',').filter(Boolean)) {
        const [k, v] = kv.split('=')
        if (!['platform', 'role', 'map', 'bots'].includes(k) || v === undefined || v === '') throw new Error(`budget "${spec}": bad scope "${kv}"`)
        b[k] = k === 'bots' ? Number(v) : v
    }
    return b
}
export const budgetSpec = (b) => `${b.metric}${b.max !== undefined ? '<=' + b.max : '>=' + b.min}` +
    (['platform', 'role', 'map', 'bots'].filter((k) => b[k] !== undefined && b[k] !== '').length
        ? '@' + ['platform', 'role', 'map', 'bots'].filter((k) => b[k] !== undefined && b[k] !== '').map((k) => `${k}=${b[k]}`).join(',') : '')

export function normaliseBudgets(list) {
    if (!Array.isArray(list)) throw new Error('budgets must be a list')
    return list.map((b) => (typeof b === 'string' ? parseBudgetSpec(b) : b)).map((b) => {
        if (!b || typeof b.metric !== 'string' || (num(b.max) === undefined && num(b.min) === undefined)) throw new Error('budget needs a metric and a max or min')
        return b
    })
}

const applies = (b, run) => (!b.platform || b.platform === run.platform) && (!b.role || b.role === run.role) && (!b.map || b.map === run.map) &&
    (b.bots === undefined || b.bots === null || Number(b.bots) === Number(run.bots ?? 0))

/** Budgets that apply to `run` ({platform, role, map, bots}) and which `metrics` break. Missing metric = not checked. */
export function evaluateBudgets(budgets, run, metrics) {
    const breaches = []
    const checked = []
    for (const b of budgets) {
        if (!applies(b, run)) continue
        const v = metrics[b.metric]
        if (v === undefined) continue
        checked.push(b)
        const hi = num(b.max) !== undefined && v > b.max
        const lo = num(b.min) !== undefined && v < b.min
        if (hi || lo) breaches.push({ ...b, value: v, limit: hi ? b.max : b.min, op: hi ? 'max' : 'min', over: hi ? v - b.max : b.min - v })
    }
    return { breaches, checked }
}

// ---------- comparison ----------

/** Metric deltas B vs A. `good` is true when B moved the better way, `regression` when it got worse by more than `noisePct`. */
export function compareMetrics(a, b, { noisePct = 5 } = {}) {
    const rows = []
    for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const av = a[name]
        const bv = b[name]
        const row = { metric: name, a: av, b: bv, delta: undefined, pct: undefined, verdict: 'same' }
        if (av !== undefined && bv !== undefined) {
            row.delta = bv - av
            row.pct = av !== 0 ? (row.delta / Math.abs(av)) * 100 : row.delta === 0 ? 0 : Infinity
            const worse = betterOf(name) === 'higher' ? row.delta < 0 : row.delta > 0
            if (Math.abs(row.pct) > noisePct) row.verdict = worse ? 'worse' : 'better'
        } else row.verdict = av === undefined ? 'new' : 'gone'
        rows.push(row)
    }
    return rows.sort((x, y) => Math.abs(y.pct ?? 0) - Math.abs(x.pct ?? 0) || x.metric.localeCompare(y.metric))
}

/** Function-table deltas by name (self ms); only rows present in either run, biggest absolute change first. */
export function compareFunctions(a, b, { noisePct = 5, minAbs = 0.01 } = {}) {
    const am = new Map(a.map((f) => [f.name, f]))
    const bm = new Map(b.map((f) => [f.name, f]))
    const rows = []
    for (const name of new Set([...am.keys(), ...bm.keys()])) {
        const av = am.get(name)?.selfMs
        const bv = bm.get(name)?.selfMs
        const delta = (bv ?? 0) - (av ?? 0)
        const pct = av ? (delta / av) * 100 : bv ? Infinity : 0
        if (Math.abs(delta) < minAbs) continue
        const verdict = av === undefined ? 'new' : bv === undefined ? 'gone' : Math.abs(pct) <= noisePct ? 'same' : delta > 0 ? 'worse' : 'better'
        rows.push({ name, a: av, b: bv, delta, pct, verdict, addon: (bm.get(name) ?? am.get(name)).addon, grp: (bm.get(name) ?? am.get(name)).grp })
    }
    return rows.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
}

/** Regression markers for a trend series [{commit, ranAt, value}] oldest first: a point worse than the median of the
 *  `window` points before it by more than `noisePct` percent. Returns the indexes. */
export function regressionMarkers(series, metric, { window = 5, noisePct = 10 } = {}) {
    const out = []
    for (let i = 1; i < series.length; i++) {
        const prev = series.slice(Math.max(0, i - window), i).map((p) => p.value).sort((x, y) => x - y)
        const med = prev[Math.floor(prev.length / 2)]
        if (!med) continue
        const pct = ((series[i].value - med) / Math.abs(med)) * 100
        if (betterOf(metric) === 'higher' ? pct < -noisePct : pct > noisePct) out.push(i)
    }
    return out
}
