import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { bucketOf, createGh, describe, isRateLimited, lowBuckets, parseRateLimit, retryDelay, waitFor } from './gh.mjs'

const rl = (core, reset = 2000, search = 30, graphql = 5000) => JSON.stringify({ resources: {
    core: { limit: 5000, remaining: core, reset }, search: { limit: 30, remaining: search, reset }, graphql: { limit: 5000, remaining: graphql, reset } } })

test('parseRateLimit reads the three buckets, reset in ms', () => {
    const s = parseRateLimit(rl(4000))
    assert.equal(s.core.remaining, 4000)
    assert.equal(s.core.reset, 2_000_000)
    assert.deepEqual(Object.keys(s).sort(), ['core', 'graphql', 'search'])
    assert.deepEqual(parseRateLimit('{}'), {})
})

test('bucketOf', () => {
    assert.equal(bucketOf(['run', 'list', '-R', 'a/b']), 'core')
    assert.equal(bucketOf(['api', 'graphql', '-f', 'query=x']), 'graphql')
    assert.equal(bucketOf(['api', 'search/issues', '-f', 'q=x']), 'search')
    assert.equal(bucketOf(['search', 'repos', 'x']), 'search')
    assert.equal(bucketOf(['api', 'rate_limit']), 'free')
})

test('waitFor: go while above minLeft, wait for the reset at or below it', () => {
    assert.equal(waitFor({ remaining: 101, reset: 10_000 }, 0, 100), 0)
    assert.equal(waitFor({ remaining: 100, reset: 10_000 }, 4000, 100), 7000)
    assert.equal(waitFor({ remaining: 0, reset: 1000 }, 5000, 100), 1000)
    assert.equal(waitFor(undefined, 0), 0)
    assert.equal(waitFor({ remaining: 0, reset: 9e9 }, 0, 0), 0, 'minLeft 0 switches the guard off')
})

test('isRateLimited recognises primary, secondary and 429 messages, never a success', () => {
    assert.ok(isRateLimited(1, 'gh: API rate limit exceeded for user ID 1 (HTTP 403)'))
    assert.ok(isRateLimited(1, 'You have exceeded a secondary rate limit'))
    assert.ok(isRateLimited(1, 'HTTP 429'))
    assert.ok(!isRateLimited(0, 'rate limit'))
    assert.ok(!isRateLimited(1, 'HTTP 404: Not Found'))
})

test('retryDelay doubles and caps', () => {
    const o = { baseDelayMs: 1000, capDelayMs: 5000 }
    assert.deepEqual([0, 1, 2, 3].map((a) => retryDelay(a, o)), [1000, 2000, 4000, 5000])
    assert.equal(retryDelay(0, o, 1), 1250)
})

test('lowBuckets and describe', () => {
    const s = parseRateLimit(rl(500))
    assert.deepEqual(lowBuckets(s, 20).map((b) => b.bucket), ['core'])
    assert.equal(lowBuckets(s, 5).length, 0)
    assert.equal(describe(['run', 'list', '-R', 'a/b', '--json', 'x']), 'run list a/b')
})

function harness(coreSeq, { now = { t: 1_000_000 }, retries = 2 } = {}) {
    const db = new DatabaseSync(':memory:')
    const calls = []
    const sleeps = []
    let rate = 0
    const run = (args) => {
        calls.push(args.join(' '))
        if (args[0] === 'api' && args[1] === 'rate_limit') return { status: 0, stdout: rl(coreSeq.remaining ?? 4000, coreSeq.reset ?? 2000), stderr: '' }
        const next = (coreSeq.results ?? [{ status: 0, stdout: '[]' }])[Math.min(rate++, (coreSeq.results?.length ?? 1) - 1)]
        return { stderr: '', stdout: '', ...next }
    }
    const gh = createGh({ db, run, sleep: (ms) => { sleeps.push(ms); now.t += ms }, now: () => now.t, jitter: () => 0, settings: { retries } })
    return { db, gh, calls, sleeps, now }
}

test('a normal call is logged with caller, bucket and status; the rate sample is stored', () => {
    const h = harness({})
    const r = h.gh.call(['run', 'list', '-R', 'a/b'], { caller: 'releases-sync' })
    assert.equal(r.status, 0)
    const row = h.db.prepare('SELECT * FROM gh_call').get()
    assert.equal(row.caller, 'releases-sync'); assert.equal(row.bucket, 'core'); assert.equal(row.cmd, 'run list a/b'); assert.equal(row.limited, 0)
    assert.equal(h.db.prepare('SELECT count(*) n FROM gh_rate').get().n, 3)
})

test('a nearly empty bucket with a far reset skips the call without sending it', () => {
    const h = harness({ remaining: 10, reset: 1_000_000 / 1000 + 3600 })
    const r = h.gh.call(['run', 'list', '-R', 'a/b'], { caller: 'ci' })
    assert.ok(r.skipped && r.limited && r.status === 75)
    assert.ok(!h.calls.some((c) => c.startsWith('run list')))
    assert.equal(h.db.prepare('SELECT skipped FROM gh_call').get().skipped, 1)
})

test('a short wait is slept, then the call goes', () => {
    const h = harness({ remaining: 10, reset: 1_000_000 / 1000 + 5 })
    const r = h.gh.call(['run', 'list'], { caller: 'ci' })
    assert.equal(r.status, 0)
    assert.equal(h.sleeps[0], 6000)
    assert.equal(r.waitedMs, 6000)
})

test('a rate-limited response is retried with backoff and recorded as limited', () => {
    const h = harness({ results: [{ status: 1, stderr: 'API rate limit exceeded' }, { status: 1, stderr: 'API rate limit exceeded' }, { status: 0, stdout: 'ok' }] })
    const r = h.gh.call(['run', 'list'], { caller: 'ci' })
    assert.equal(r.status, 0); assert.ok(r.limited)
    assert.deepEqual(h.sleeps.slice(0, 2), [1500, 3000])
    assert.equal(h.db.prepare('SELECT limited FROM gh_call').get().limited, 1)
})

test('retries are bounded, and other failures are not retried', () => {
    const h = harness({ results: [{ status: 1, stderr: 'HTTP 429' }] }, { retries: 1 })
    const r = h.gh.call(['run', 'list'])
    assert.equal(r.status, 1); assert.ok(r.limited)
    assert.equal(h.calls.filter((c) => c.startsWith('run list')).length, 2)
    const h2 = harness({ results: [{ status: 1, stderr: 'HTTP 404: Not Found' }] })
    const r2 = h2.gh.call(['run', 'list'])
    assert.ok(!r2.limited); assert.equal(h2.calls.filter((c) => c.startsWith('run list')).length, 1)
})
