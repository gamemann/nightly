// The one place nightly's lib code calls GitHub (`gh`). Every call is recorded (who, what, how long, did it hit the rate limit) in
// `gh_call`, the rate-limit buckets are sampled into `gh_rate` (`gh api rate_limit` does not count against the limit), and a call
// is refused or delayed while its bucket is nearly empty: the Usage page charts both tables and warns when a bucket runs low.
// The decision logic is pure (parseRateLimit, bucketOf, waitFor, isRateLimited, retryDelay) so lib/gh.test.mjs covers it without gh.
import { spawnSync } from 'node:child_process'
import { ensure } from './ops-store.mjs'

export const BUCKETS = ['core', 'search', 'graphql']
/** Defaults; settings ghMinLeft / ghMaxWaitSec / ghRetries override (0 = off where it makes sense). */
export const DEFAULTS = { minLeft: 100, maxWaitMs: 30_000, retries: 2, sampleTtlMs: 60_000, baseDelayMs: 1500, capDelayMs: 20_000, warnPct: 20 }

/** `gh api rate_limit` JSON -> { core: {limit, remaining, reset(ms epoch)}, search, graphql }. Missing buckets are omitted. */
export function parseRateLimit(json) {
    const r = typeof json === 'string' ? JSON.parse(json) : json
    const out = {}
    for (const b of BUCKETS) {
        const x = r?.resources?.[b]
        if (x && Number.isFinite(x.limit)) out[b] = { limit: x.limit, remaining: x.remaining, reset: Number(x.reset) * 1000 }
    }
    return out
}

/** Which rate-limit bucket a gh invocation draws from. */
export function bucketOf(args) {
    const a = args.filter((x) => !x.startsWith('-'))
    if (a[0] === 'api') {
        if (a[1] === 'graphql') return 'graphql'
        if (a[1] === 'rate_limit') return 'free'
        if (/^\/?search\//.test(a[1] ?? '')) return 'search'
        return 'core'
    }
    if (a[0] === 'search') return 'search'
    return 'core'
}

/** Milliseconds to wait before calling a bucket (0 = go). remaining <= minLeft means wait for the reset. */
export function waitFor(state, now, minLeft = DEFAULTS.minLeft) {
    if (!state || minLeft <= 0) return 0
    if (state.remaining > minLeft) return 0
    return Math.max(0, state.reset - now) + 1000
}

export const isRateLimited = (status, stderr = '') =>
    status !== 0 && /rate limit|secondary rate|abuse detection|API rate limit exceeded|HTTP 429|retry-after/i.test(String(stderr))

/** Exponential backoff with a cap; `jitter` in [0,1) (injectable for tests). */
export const retryDelay = (attempt, { baseDelayMs, capDelayMs } = DEFAULTS, jitter = 0) =>
    Math.min(capDelayMs, Math.round(baseDelayMs * 2 ** attempt * (1 + 0.25 * jitter)))

/** Buckets worth a warning: { bucket, remaining, limit, pct, resetAt } with pct <= warnPct. */
export function lowBuckets(state, warnPct = DEFAULTS.warnPct) {
    return Object.entries(state ?? {}).map(([bucket, s]) => ({ bucket, remaining: s.remaining, limit: s.limit, pct: s.limit ? Math.round((s.remaining / s.limit) * 100) : 100, resetAt: s.reset }))
        .filter((b) => b.pct <= warnPct)
}

/** First callable-looking words of a gh invocation, for the log (no flags values, no tokens, no bodies). */
export const describe = (args) => {
    const out = []
    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith('-')) { if (!args[i].includes('=') && i + 1 < args.length && !args[i + 1].startsWith('-') && args[i] !== '-R' && args[i] !== '--repo') i++; continue }
        out.push(args[i])
    }
    return out.slice(0, 4).join(' ').slice(0, 80)
}

const realRun = (args, opts = {}) => spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 60_000, ...opts })
const realSleep = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

/**
 * createGh({ db, run, sleep, now, settings }) -> { call, rate, state, ... }.
 *   call(args, { caller, input }) -> { status, stdout, stderr, limited, skipped, bucket, waitedMs }
 * A call is `skipped` (status 75, nothing sent) when its bucket is nearly empty and the reset is further away than maxWaitMs;
 * a shorter wait is slept. A response that says rate-limited is retried with backoff (retries times) and recorded as limited.
 */
export function createGh({ db = null, run = realRun, sleep = realSleep, now = Date.now, settings = {}, jitter = Math.random } = {}) {
    const cfg = { ...DEFAULTS, ...Object.fromEntries(Object.entries(settings).filter(([, v]) => Number.isFinite(v))) }
    if (db) ensure(db)
    let cache = null // { at, state }
    const insRate = db?.prepare('INSERT INTO gh_rate (ts, bucket, "limit", remaining, reset) VALUES (?,?,?,?,?)')
    const insCall = db?.prepare('INSERT INTO gh_call (ts, caller, bucket, cmd, status, ms, limited, skipped, waited_ms) VALUES (?,?,?,?,?,?,?,?,?)')

    /** Sample the buckets now (free). Returns the parsed state or null when gh cannot say. */
    function sample() {
        const r = run(['api', 'rate_limit'])
        if (r.status !== 0) return cache?.state ?? null
        let state
        try { state = parseRateLimit(r.stdout) } catch { return cache?.state ?? null }
        cache = { at: now(), state }
        if (insRate) for (const [b, s] of Object.entries(state)) insRate.run(now(), b, s.limit, s.remaining, s.reset)
        return state
    }
    const state = (fresh = false) => (!fresh && cache && now() - cache.at < cfg.sampleTtlMs ? cache.state : sample())

    function call(args, { caller = 'unknown', input } = {}) {
        const bucket = bucketOf(args)
        const t0 = now()
        let waited = 0, limited = false, res
        const record = (status, skipped) => insCall?.run(t0, caller, bucket, describe(args), status, now() - t0, limited ? 1 : 0, skipped ? 1 : 0, waited)
        if (bucket !== 'free') {
            const w = waitFor(state()?.[bucket], now(), cfg.minLeft)
            if (w > cfg.maxWaitMs) {
                record(75, true)
                return { status: 75, stdout: '', stderr: `gh rate limit: ${bucket} bucket nearly empty, resets in ${Math.ceil(w / 1000)}s; call skipped`, limited: true, skipped: true, bucket, waitedMs: 0 }
            }
            if (w > 0) { sleep(w); waited += w; state(true) }
        }
        for (let attempt = 0; ; attempt++) {
            res = run(args, input !== undefined ? { input } : {})
            if (!isRateLimited(res.status, res.stderr) || bucket === 'free') break
            limited = true
            cache = null
            if (attempt >= cfg.retries) break
            const d = Math.max(retryDelay(attempt, cfg, jitter()), Math.min(cfg.maxWaitMs, waitFor(state(true)?.[bucket], now(), cfg.minLeft)))
            if (d > cfg.maxWaitMs) break
            sleep(d); waited += d
        }
        record(res.status ?? -1, false)
        return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '', limited, skipped: false, bucket, waitedMs: waited }
    }
    return { call, sample, state, cfg }
}

/** gh with settings from the database (ghMinLeft, ghMaxWaitSec, ghRetries); the usual entry point of the CLI. */
export function ghFor(db, getSetting) {
    const n = (k, mul = 1) => { const v = getSetting(db, k); return v === null || v === '' ? undefined : Number(v) * mul }
    return createGh({ db, settings: { minLeft: n('ghMinLeft'), maxWaitMs: n('ghMaxWaitSec', 1000), retries: n('ghRetries'), warnPct: n('ghWarnPct') } })
}
