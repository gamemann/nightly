// Web checks: probe each dev site (HTTP status + latency) and post the samples as budgeted series (nightly web probe; scheduled every 15 minutes).
// Targets are host-specific, so they live in the DB setting webProbeTargets (JSON [{"game":"site","url":"https://..."}]), never in this public repo:
//   nightly set-setting webProbeTargets '[{"game":"gamespice","url":"https://example.test/"}]'
// Metrics per target: http_fail (0 = HTTP 2xx/3xx, 1 = error/timeout/5xx/4xx; budget max 0) and latency_ms (budget max 3000, only when it answered).
// --frame additionally loads the url in headless Chromium (Playwright, if installed) and records frame_ms (time to load event).
import tls from 'node:tls'
import * as F from './feeds.mjs'
import * as S from './store.mjs'

// the dev sites use the host's CA store (private CA), not node's bundled one
try { tls.setDefaultCACertificates([...tls.getCACertificates('bundled'), ...tls.getCACertificates('system')]) } catch { /* older node: set NODE_USE_SYSTEM_CA=1 */ }
const TIMEOUT_MS = 15_000
export const DEFAULT_BUDGETS = [['http_fail', 0, ''], ['latency_ms', 3000, 'ms'], ['frame_ms', 10_000, 'ms']]

export function targetsOf(db, override) {
    const raw = override ?? S.getSetting(db, 'webProbeTargets')
    if (!raw) throw new Error('no targets: nightly set-setting webProbeTargets \'[{"game":"site","url":"https://..."}]\'')
    let t
    try { t = JSON.parse(raw) } catch { throw new Error('webProbeTargets is not JSON') }
    if (!Array.isArray(t) || !t.every((x) => x && x.game && x.url)) throw new Error('webProbeTargets must be an array of {game, url}')
    return t
}

async function fetchOnce(url) {
    const t0 = performance.now()
    try {
        const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': 'nightly-webcheck' } })
        await res.arrayBuffer()
        return { ok: res.status < 400, status: res.status, ms: Math.round(performance.now() - t0) }
    } catch (e) { return { ok: false, status: 0, ms: Math.round(performance.now() - t0), error: String(e?.cause?.code ?? e?.name ?? e) } }
}

async function frameMs(url) {
    let pw
    try { pw = await import('playwright') } catch { return null }
    const b = await pw.chromium.launch()
    try {
        const p = await b.newPage(), t0 = performance.now()
        await p.goto(url, { timeout: TIMEOUT_MS, waitUntil: 'load' })
        return Math.round(performance.now() - t0)
    } catch { return null } finally { await b.close() }
}

export async function probe(db, { targets, frame = false, dry = false, at = new Date() } = {}) {
    const list = targetsOf(db, targets)
    const samples = []
    for (const t of list) {
        const r = await fetchOnce(t.url)
        const base = { game: t.game, url: t.url, at: at.toISOString() }
        samples.push({ ...base, metric: 'http_fail', value: r.ok ? 0 : 1, note: r.error ?? r.status })
        if (r.status) samples.push({ ...base, metric: 'latency_ms', value: r.ms })
        if (frame || t.frame) { const m = await frameMs(t.url); if (m !== null) samples.push({ ...base, metric: 'frame_ms', value: m }) }
    }
    if (!dry) {
        const have = new Set(F.budgets(db).map((b) => `${b.game}/${b.metric}`))
        for (const s of samples) {
            if (!have.has(`${s.game}/${s.metric}`)) { const d = DEFAULT_BUDGETS.find((x) => x[0] === s.metric); if (d) { F.setBudget(db, s.game, s.metric, d[1], d[2]); have.add(`${s.game}/${s.metric}`) } }
            F.add(db, 'web', { game: s.game, metric: s.metric, value: s.value, url: s.url, at: s.at })
        }
    }
    return { samples, failed: samples.filter((s) => s.metric === 'http_fail' && s.value).length }
}
