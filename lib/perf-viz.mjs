// PERFORMANCE tab visuals as plain SVG/markdown strings: flame/icicle graphs, the differential flame graph, sparklines,
// hitch timelines and the per-run report. Pure (no database, no DOM) so the CLI, the panel and the tests share one renderer.
import * as P from './perf.mjs'

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const f2 = (n) => (Number.isFinite(n) ? +n.toFixed(Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 10 ? 1 : 2) : 0)

/** Folded stack text ("a;b;c us") from a report: the embedded stacks, else the v2 `tree` (self ms per frame -> us), else ''. */
export function foldedFromReport(j) {
    const e = P.embeddedFolded(j)
    if (e) return e
    if (!Array.isArray(j?.tree)) return ''
    const rows = []
    for (const r of j.tree) {
        const us = Number(r?.self_ms) * 1000
        if (typeof r?.path === 'string' && r.path && us > 0) rows.push(`${r.path} ${Math.round(us * 1000) / 1000}`)
    }
    return rows.join('\n')
}

/** Hitch / worst-frame points [{t, ms}] (t in seconds when known) from a report; v2 worst_frames, v1 hitches, spikes with a ms field. */
export function hitchesFromReport(j, top = 60) {
    const out = []
    for (const k of ['worst_frames', 'hitches', 'spikes']) {
        if (!Array.isArray(j?.[k])) continue
        j[k].forEach((h, i) => {
            const ms = Number(h?.ms ?? h?.frame_ms ?? h?.max_ms)
            if (Number.isFinite(ms) && ms > 0) out.push({ t: Number.isFinite(Number(h?.t ?? h?.time_s)) ? Number(h.t ?? h.time_s) : i, ms })
        })
        if (out.length) break
    }
    return out.sort((a, b) => b.ms - a.ms).slice(0, top).sort((a, b) => a.t - b.t)
}

/** Trie from folded rows [{stack, value}]. Every node carries `self` and `total` (value units). */
export function buildTree(rows) {
    const root = { name: 'all', self: 0, total: 0, kids: new Map() }
    for (const { stack, value } of rows) {
        if (!(value > 0)) continue
        let n = root
        n.total += value
        for (const part of stack.split(';')) {
            let k = n.kids.get(part)
            if (!k) n.kids.set(part, (k = { name: part, self: 0, total: 0, kids: new Map() }))
            k.total += value
            n = k
        }
        n.self += value
    }
    return root
}
const foldedRows = (text) => P.parseFolded(text ?? '')

const hue = (name) => { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0; return 20 + (h % 40) } // warm flame palette
const wrap = (w, h, body, title) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="ui-monospace,Menlo,monospace" font-size="11"><rect width="${w}" height="${h}" fill="#fff"/>` +
    (title ? `<text x="6" y="14" font-size="12" font-weight="bold" fill="#222">${esc(title)}</text>` : '') + body + '</svg>'

/** Layout `node` (children sorted by name for a stable diff) into rects. `size(node)` gives the width weight; `color(node)` the fill. */
function layout(node, size, x, w, depth, out, min) {
    out.push({ node, x, w, depth })
    let cx = x
    const kids = [...node.kids.values()].sort((a, b) => (a.name < b.name ? -1 : 1))
    const tot = size(node) || 1
    for (const k of kids) {
        const kw = (size(k) / tot) * w
        if (kw >= min) layout(k, size, cx, kw, depth + 1, out, min)
        cx += kw
    }
}
function rects(out, row, title0, color, label) {
    return out.map(({ node, x, w, depth }) => {
        const y = 24 + depth * row
        const txt = w > 34 ? `<text x="${x + 3}" y="${y + row - 5}" fill="#111" pointer-events="none">${esc(node.name.slice(0, Math.max(0, Math.floor(w / 6.4) - 1)))}</text>` : ''
        return `<g><title>${esc(label(node))}</title><rect x="${x.toFixed(2)}" y="${y}" width="${Math.max(w - 0.5, 0.3).toFixed(2)}" height="${row - 1}" fill="${color(node)}"/>${txt}</g>`
    }).join('')
}

/** Flame graph as SVG (icicle: root on top). `text` is folded stacks; values are microseconds per frame. */
export function flameSvg(text, { width = 1100, row = 17, title = 'flame graph', minPx = 0.6 } = {}) {
    const root = buildTree(foldedRows(text))
    if (!root.total) return wrap(width, 40, '<text x="6" y="34" fill="#666">no stacks stored for this run</text>', title)
    const out = []
    layout(root, (n) => n.total, 0, width, 0, out, minPx)
    const depth = Math.max(...out.map((r) => r.depth)) + 1
    return wrap(width, 30 + depth * row, rects(out, row, title, (n) => `hsl(${hue(n.name)},85%,${n.name === 'all' ? 85 : 62}%)`, (n) => `${n.name}: ${f2(n.total / 1000)} ms total, ${f2(n.self / 1000)} ms self`), title)
}

/** Merge two folded texts into one trie of {a, b} values; width follows max(a, b) so removed and added frames both stay visible. */
export function diffTree(textA, textB) {
    const mk = () => ({ name: '', a: 0, b: 0, total: 0, kids: new Map() })
    const root = mk(); root.name = 'all'
    const add = (text, key) => {
        for (const { stack, value } of foldedRows(text)) {
            if (!(value > 0)) continue
            let n = root
            n[key] += value
            for (const part of stack.split(';')) {
                let k = n.kids.get(part)
                if (!k) { k = mk(); k.name = part; n.kids.set(part, k) }
                k[key] += value
                n = k
            }
        }
    }
    add(textA, 'a'); add(textB, 'b')
    const fin = (n) => { n.total = Math.max(n.a, n.b); n.kids.forEach(fin) }
    fin(root)
    return root
}
/** Red = slower in B, green = faster, grey = within `noisePct` (of the A value; a new frame is red, a vanished one green). */
export const deltaColor = (a, b, noisePct = 5) => {
    const d = b - a
    const rel = a > 0 ? Math.abs(d) / a * 100 : 100
    if (Math.abs(d) < 1 || rel <= noisePct) return '#d9d9d9'
    const k = Math.min(1, rel / 100)
    const l = Math.round(88 - 38 * k)
    return d > 0 ? `hsl(5,80%,${l}%)` : `hsl(130,55%,${l}%)`
}
/** Differential flame graph (B against A) as SVG. */
export function diffFlameSvg(textA, textB, { width = 1100, row = 17, title = 'differential flame graph (red = slower, green = faster)', noisePct = 5, minPx = 0.6 } = {}) {
    const root = diffTree(textA, textB)
    if (!root.total) return wrap(width, 40, '<text x="6" y="34" fill="#666">neither run has stacks</text>', title)
    const out = []
    layout(root, (n) => n.total, 0, width, 0, out, minPx)
    const depth = Math.max(...out.map((r) => r.depth)) + 1
    return wrap(width, 30 + depth * row, rects(out, row, title, (n) => deltaColor(n.a, n.b, noisePct), (n) => `${n.name}: ${f2(n.a / 1000)} ms -> ${f2(n.b / 1000)} ms (${n.b - n.a >= 0 ? '+' : ''}${f2((n.b - n.a) / 1000)} ms)`), title)
}
/** Biggest changes of a diff as rows [{path, a, b, delta}] (microseconds), sorted by |delta|; leaf-level self-time deltas only. */
export function diffRows(textA, textB, { top = 15 } = {}) {
    const rows = []
    const walk = (n, path) => {
        const a = n.a - [...n.kids.values()].reduce((s, k) => s + k.a, 0)
        const b = n.b - [...n.kids.values()].reduce((s, k) => s + k.b, 0)
        if (path && (a || b)) rows.push({ path, a, b, delta: b - a })
        n.kids.forEach((k) => walk(k, path ? `${path};${k.name}` : k.name))
    }
    walk(diffTree(textA, textB), '')
    return rows.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta)).slice(0, top)
}

/** Tiny line chart as SVG: values [..], optional budget line and highlighted last point. */
export function sparklineSvg(values, { width = 120, height = 24, budget, color = '#2563eb' } = {}) {
    const v = values.filter((x) => Number.isFinite(x))
    if (v.length < 2) return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"></svg>`
    const all = budget !== undefined ? [...v, budget] : v
    const lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 1
    const X = (i) => (i / (v.length - 1)) * (width - 4) + 2
    const Y = (x) => height - 3 - ((x - lo) / span) * (height - 6)
    const pts = v.map((x, i) => `${X(i).toFixed(1)},${Y(x).toFixed(1)}`).join(' ')
    const bl = budget !== undefined ? `<line x1="0" x2="${width}" y1="${Y(budget).toFixed(1)}" y2="${Y(budget).toFixed(1)}" stroke="#dc2626" stroke-dasharray="3 2"/>` : ''
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${bl}<polyline fill="none" stroke="${color}" stroke-width="1.5" points="${pts}"/><circle cx="${X(v.length - 1).toFixed(1)}" cy="${Y(v[v.length - 1]).toFixed(1)}" r="2.2" fill="${color}"/></svg>`
}

/** Hitch timeline as SVG: one bar per hitch at its time, height = frame ms, with an optional budget line. */
export function hitchSvg(hitches, { width = 1100, height = 120, budgetMs, title = 'hitch timeline' } = {}) {
    if (!hitches.length) return wrap(width, 40, '<text x="6" y="34" fill="#666">no hitches recorded</text>', title)
    const t0 = Math.min(...hitches.map((h) => h.t)), t1 = Math.max(...hitches.map((h) => h.t), t0 + 1)
    const top = Math.max(...hitches.map((h) => h.ms), budgetMs ?? 0)
    const X = (t) => 8 + ((t - t0) / (t1 - t0)) * (width - 16)
    const H = (ms) => (ms / top) * (height - 34)
    const bars = hitches.map((h) => `<g><title>${f2(h.ms)} ms at ${f2(h.t)} s</title><rect x="${(X(h.t) - 1.5).toFixed(1)}" y="${(height - 6 - H(h.ms)).toFixed(1)}" width="3" height="${H(h.ms).toFixed(1)}" fill="#dc2626"/></g>`).join('')
    const bl = budgetMs ? `<line x1="0" x2="${width}" y1="${(height - 6 - H(budgetMs)).toFixed(1)}" y2="${(height - 6 - H(budgetMs)).toFixed(1)}" stroke="#2563eb" stroke-dasharray="4 3"/>` : ''
    return wrap(width, height, bl + bars, `${title} (${hitches.length}, worst ${f2(top)} ms)`)
}

const HEADLINE = ['fps', 'frame_ms_p50', 'frame_ms_p95', 'frame_ms_p99', 'tick_ms', 'draw_calls', 'memory_mb', 'net_in_kbps', 'net_out_kbps']
/** Per-run report as markdown for READMEs and PRs. `base` = metrics of a baseline run (optional), `gate` = a gate verdict (optional). */
export function reportMarkdown({ game, run, metrics, budgets = [], base = null, gate = null, top = [], links = {} }) {
    const L = [`### Perf report: ${game.name || game.slug} run ${run.id}`, '',
        `${run.platform}/${run.role}${run.map ? ' ' + run.map : ''}${run.bots ? `, ${run.bots} bots` : ''}${run.commit ? `, commit \`${run.commit.slice(0, 10)}\`` : ''}, ${String(run.ranAt).slice(0, 16).replace('T', ' ')}` + (gate ? `, gate **${gate.pass ? 'PASS' : 'FAIL'}**` : ''), '',
        '| metric | value | budget | vs baseline |', '|---|---:|---:|---:|']
    for (const m of [...HEADLINE, ...Object.keys(metrics).filter((k) => !HEADLINE.includes(k)).slice(0, 4)]) {
        if (!Number.isFinite(metrics[m])) continue
        const bud = budgets.filter((b) => b.metric === m && (!b.platform || b.platform === run.platform) && (!b.role || b.role === run.role) && (!b.map || b.map === run.map) && (b.bots === undefined || b.bots === run.bots)).map((b) => (b.max !== undefined ? `<= ${b.max}` : `>= ${b.min}`)).join(', ')
        const bv = base?.[m]
        const d = Number.isFinite(bv) && bv !== 0 ? ((metrics[m] - bv) / Math.abs(bv)) * 100 : NaN
        const worse = Number.isFinite(d) && (P.betterOf(m) === 'higher' ? d < -5 : d > 5), better = Number.isFinite(d) && (P.betterOf(m) === 'higher' ? d > 5 : d < -5)
        L.push(`| ${m} | ${f2(metrics[m])}${P.unitOf(m)} | ${bud || '-'} | ${Number.isFinite(d) ? `${d >= 0 ? '+' : ''}${d.toFixed(1)}%${worse ? ' (worse)' : better ? ' (better)' : ''}` : '-'} |`)
    }
    if (gate?.failures?.length) L.push('', 'Gate failures:', ...gate.failures.map((f) => `- ${f}`))
    if (top.length) L.push('', 'Top self time per frame:', ...top.map((f) => `- \`${f.name}\` ${f2(f.selfMs)} ms`))
    if (links.image) L.push('', `![perf report](${links.image})`)
    return L.join('\n') + '\n'
}

/** Per-run report as a standalone SVG card (headline metrics with budget colour, plus the flame graph if stacks exist). */
export function reportSvg({ game, run, metrics, budgets = [], gate = null, folded = '' }, { width = 1100 } = {}) {
    const cells = HEADLINE.filter((m) => Number.isFinite(metrics[m]))
    const cw = Math.max(110, Math.floor((width - 12) / Math.max(1, cells.length)))
    let body = `<text x="6" y="34" fill="#444">${esc(`${run.platform}/${run.role}${run.map ? ' ' + run.map : ''}${run.bots ? ', ' + run.bots + ' bots' : ''}${run.commit ? ', ' + run.commit.slice(0, 10) : ''}, ${String(run.ranAt).slice(0, 16).replace('T', ' ')}`)}</text>`
    cells.forEach((m, i) => {
        const bad = P.evaluateBudgets(budgets, run, { [m]: metrics[m] }).breaches.length > 0
        body += `<g transform="translate(${6 + i * cw},46)"><rect width="${cw - 6}" height="44" rx="4" fill="${bad ? '#fee2e2' : '#f1f5f9'}"/><text x="6" y="16" fill="#555">${esc(m)}</text><text x="6" y="36" font-size="15" font-weight="bold" fill="${bad ? '#b91c1c' : '#111'}">${f2(metrics[m])}${esc(P.unitOf(m))}</text></g>`
    })
    let h = 100
    if (folded) {
        const inner = flameSvg(folded, { width, title: 'where the time goes' }).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '')
        body += `<g transform="translate(0,${h})">${inner}</g>`
        h += Number(/height="(\d+)"/.exec(flameSvg(folded, { width, title: 'x' }))?.[1] ?? 60)
    }
    return wrap(width, h + 4, body, `Perf report: ${game.name || game.slug} run ${run.id}${gate ? (gate.pass ? ' - gate PASS' : ' - gate FAIL') : ''}`)
}

/** Best folded text for a run from what is stored: stacks.folded, else the report (embedded stacks / v2 tree), else the per-function rows. */
export function bestFolded({ stacks = '', report = '', funcs = [] } = {}) {
    if (stacks && stacks.trim()) return stacks
    if (report) { try { const f = foldedFromReport(JSON.parse(report)); if (f) return f } catch { /* not json */ } }
    return funcs.filter((f) => f.selfMs > 0 && f.per !== 'tick').map((f) => `${f.path && f.path.includes(';') ? f.path : f.name} ${Math.round(f.selfMs * 1000 * 1000) / 1000}`).join('\n')
}
