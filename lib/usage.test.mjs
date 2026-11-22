// Run: node --test lib/usage.test.mjs   (synthetic fixtures only)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-test-'))
process.env.NIGHTLY_DB = path.join(tmp, 'n.db')
const S = await import('./store.mjs')
const P = await import('./usage-parse.mjs')
const PR = await import('./usage-price.mjs')
const CH = await import('./usage-ch.mjs')
const ST = await import('./usage-store.mjs')
const F = await import('./usage-fixture.mjs')

const newDb = () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE Setting (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    return db
}
const t0 = Date.UTC(2026, 10, 20, 10)

test('parser: one row per message id, last usage wins, tools unioned', () => {
    const text = [
        F.assistant({ id: 'm1', ts: t0, session: 's', output: 5, tools: [{ name: 'Read' }] }),
        F.assistant({ id: 'm1', ts: t0 + 1, session: 's', output: 90, w5: 10, tools: [{ name: 'Grep' }] }),
    ].join('\n')
    const r = P.parseTranscript(text, {})
    assert.equal(r.messages.size, 1)
    const m = r.messages.get('m1')
    assert.equal(m.output, 90); assert.equal(m.cache_5m, 10)
    assert.deepEqual(m.tools.sort(), ['Grep', 'Read'])
})
test('parser: tokens, thinking, torn lines, synthetic model, sidechain attribution', () => {
    const text = ['{not json', F.assistant({ id: 'a', ts: t0, session: 's', input: 7, output: 11, read: 13, w5: 3, w1: 4, think: 5 }),
        F.assistant({ id: 'syn', ts: t0, session: 's', model: '<synthetic>' }),
        F.assistant({ id: 'b', ts: t0, session: 's', side: true, agentId: 'x1' })].join('\n')
    const r = P.parseTranscript(text, { agentType: 'builder' })
    assert.equal(r.messages.size, 2)
    const a = r.messages.get('a')
    assert.deepEqual([a.input, a.output, a.cache_read, a.cache_5m, a.cache_1h, a.thinking], [7, 11, 13, 3, 4, 5])
    assert.equal(a.agent_type, 'main'); assert.equal(a.project, 'demo-app')
    assert.equal(r.messages.get('b').agent_type, 'builder'); assert.equal(r.messages.get('b').sidechain, 1)
})
test('parser: tool results sized, skills and idle calls attributed, privacy', () => {
    const text = [F.prompt({ ts: t0, session: 's', text: '<command-name>/ship</command-name> SECRET-PROMPT' }),
        F.assistant({ id: 'm', ts: t0 + 1, session: 's', tools: [{ id: 'tu', name: 'Bash', input: { command: 'sleep 5' } }] }),
        F.result({ ts: t0 + 2, session: 's', toolUseId: 'tu', text: 'z'.repeat(3500) })].join('\n')
    const r = P.parseTranscript(text, {})
    assert.equal(r.tools.get('tu').result_tokens, 1000)
    assert.equal(r.messages.get('m').skill, '/ship'); assert.equal(r.messages.get('m').idle, 1)
    assert.ok(!JSON.stringify([...r.messages.values(), ...r.tools.values()]).includes('SECRET-PROMPT'))
    assert.ok(!JSON.stringify([...r.messages.values()]).includes('sleep 5'))
})
test('project label modes', () => {
    assert.equal(P.projectLabel('/a/b/repo', 'basename'), 'repo')
    assert.equal(P.projectLabel('/a/b/repo', 'none'), 'project')
    const h = P.projectLabel('/a/b/repo', 'hash'); assert.match(h, /^p-[0-9a-f]+$/); assert.ok(!h.includes('repo'))
})
test('price math: matching, fallback, cache multipliers, bad input', () => {
    const p = PR.parsePrices(null)
    const c = PR.cost(p, 'claude-sonnet-4-5', { input: 1e6, output: 1e6, cache_read: 1e6, cache_5m: 1e6, cache_1h: 1e6 })
    assert.ok(Math.abs(c - (3 + 15 + 0.3 + 3.75 + 6)) < 1e-9)
    assert.ok(PR.cost(p, 'unknown-model', { input: 1e6 }) > 0)
    const custom = PR.parsePrices(JSON.stringify({ '*': { input: 1, output: 2, cache_read: 0, cache_5m: 0, cache_1h: 0 } }))
    assert.equal(PR.cost(custom, 'x', { output: 1e6 }), 2)
    assert.throws(() => PR.parsePrices('{bad'))
})
test('ClickHouse client: headers, never the password in the URL, errors, batching', async () => {
    const calls = []
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, text: async () => '' } }
    const cfg = CH.chConfig((k) => ({ usageChEnabled: 'true', usageChBatch: '2' })[k] ?? null, { NIGHTLY_CLICKHOUSE_PASSWORD: 'hunter2' })
    assert.equal(cfg.enabled, true)
    const n = await CH.chInsert(cfg, 'usage_event', [{ a: 1 }, { a: 2 }, { a: 3 }], { fetchImpl })
    assert.equal(n, 3); assert.equal(calls.length, 2)
    for (const c of calls) { assert.ok(!c.url.includes('hunter2')); assert.equal(c.init.headers['X-ClickHouse-Key'], 'hunter2'); assert.match(new URL(c.url).searchParams.get('query'), /INSERT INTO nightly_usage\.usage_event FORMAT JSONEachRow/) }
    assert.equal(calls[0].init.body, '{"a":1}\n{"a":2}')
    const bad = async () => ({ ok: false, status: 516, text: async () => 'Code: 516. auth failed' })
    await assert.rejects(CH.chInsert(cfg, 'usage_event', [{}], { fetchImpl: bad }), (e) => /516/.test(e.message) && !e.message.includes('hunter2'))
    await assert.rejects(CH.chInsert(cfg, 'nope', [], { fetchImpl }), /unknown/)
    assert.equal(CH.publicConfig(cfg).passwordSet, true); assert.ok(!JSON.stringify(CH.publicConfig(cfg)).includes('hunter2'))
    assert.throws(() => CH.chConfig((k) => (k === 'usageChDb' ? 'x; DROP' : null), {}))
})
test('ingest: tree, incremental offsets, torn tail, dedupe, agent types, compaction, push watermark', async () => {
    const root = path.join(tmp, 'tree'); const T = F.writeTree(root)
    const db = newDb()
    const s1 = await ST.ingest(db, { dirsOverride: [root], ch: false })
    assert.equal(s1.files, 2); assert.equal(s1.changed, 2)
    const msgs = db.prepare('SELECT * FROM usage_message').all()
    assert.equal(msgs.length, 2 + 9 + 1 + 1 + 2 - 1 + 0)           // msg_1, msg_2, 9 polls, msg_end, 2 sub = 14
    assert.equal(db.prepare("SELECT COUNT(*) n FROM usage_message WHERE msg_key='msg_1'").get().n, 1)
    assert.equal(db.prepare("SELECT agent_type FROM usage_message WHERE msg_key='smsg_1'").get().agent_type, 'builder')
    assert.equal(db.prepare("SELECT result_tokens r FROM usage_tool WHERE tool_use_id='tu_read'").get().r, 10000)
    assert.equal(db.prepare("SELECT COUNT(*) n FROM usage_event WHERE kind='compaction'").get().n, 1)
    assert.equal(db.prepare("SELECT skill FROM usage_message WHERE msg_key='msg_1'").get().skill, 'review')
    // unchanged -> nothing; append a half line then the rest
    const s2 = await ST.ingest(db, { dirsOverride: [root], ch: false }); assert.equal(s2.changed, 0)
    const extra = F.assistant({ id: 'msg_new', ts: T.t0 + 40 * 60000, session: T.sess, output: 77 })
    fs.appendFileSync(T.mainFile, extra.slice(0, 50))
    await ST.ingest(db, { dirsOverride: [root], ch: false })
    assert.equal(db.prepare("SELECT COUNT(*) n FROM usage_message WHERE msg_key='msg_new'").get().n, 0)
    fs.appendFileSync(T.mainFile, extra.slice(50) + '\n')
    const s3 = await ST.ingest(db, { dirsOverride: [root], ch: false }); assert.equal(s3.messages, 1)
    assert.equal(db.prepare("SELECT output o FROM usage_message WHERE msg_key='msg_new'").get().o, 77)
    // a tool result arriving in a later chunk updates the call
    fs.appendFileSync(T.mainFile, F.assistant({ id: 'm_late', ts: T.t0 + 50 * 60000, session: T.sess, tools: [{ id: 'tu_late', name: 'Read', input: { f: 1 } }] }) + '\n')
    await ST.ingest(db, { dirsOverride: [root], ch: false })
    fs.appendFileSync(T.mainFile, F.result({ ts: T.t0 + 51 * 60000, session: T.sess, toolUseId: 'tu_late', text: 'q'.repeat(700) }) + '\n')
    await ST.ingest(db, { dirsOverride: [root], ch: false })
    assert.equal(db.prepare("SELECT result_tokens r FROM usage_tool WHERE tool_use_id='tu_late'").get().r, 200)
    // push to a mock ClickHouse; second push sends nothing
    S.setSetting(db, 'usageChEnabled', 'true')
    const sent = []
    const fetchImpl = async (url, init) => { sent.push(url); return { ok: true, status: 200, text: async () => '' } }
    const cfg = ST.chConfigFrom(db)
    const p1 = await ST.pushToCh(db, cfg, { fetchImpl })
    assert.ok(p1.usage_message >= 15 && p1.usage_tool > 0 && p1.usage_event === 1)
    const n = sent.length
    const p2 = await ST.pushToCh(db, cfg, { fetchImpl })
    assert.deepEqual(p2, { usage_message: 0, usage_tool: 0, usage_event: 0 }); assert.equal(sent.length, n)
    // a failing ClickHouse does not fail the ingest and keeps the watermark
    fs.appendFileSync(T.mainFile, F.assistant({ id: 'm_after', ts: T.t0 + 60 * 60000, session: T.sess }) + '\n')
    const bad = async () => ({ ok: false, status: 500, text: async () => 'boom' })
    const s4 = await ST.ingest(db, { dirsOverride: [root], fetchImpl: bad }); assert.equal(s4.messages, 1); assert.match(s4.chError, /500/)
    const s5 = await ST.ingest(db, { dirsOverride: [root], fetchImpl }); assert.equal(s5.ch.usage_message, 1)
})
test('ingest: a missing directory is counted, not fatal; dirs default and ~ expansion', async () => {
    const db = newDb()
    const s = await ST.ingest(db, { dirsOverride: [path.join(tmp, 'nope')], ch: false })
    assert.equal(s.unreadable, 1); assert.equal(s.files, 0)
    assert.deepEqual(ST.dirs(db, {}), [path.join(os.homedir(), '.claude', 'projects')])
    S.setSetting(db, 'usageDirs', '~/a\n/b, /c')
    assert.deepEqual(ST.dirs(db, {}), [path.join(os.homedir(), 'a'), '/b', '/c'])
})

const Q = await import('./usage-query.mjs')
const sqliteBe = (db) => ({ dialect: 'sqlite', q: async (sql) => db.prepare(sql).all() })
async function seeded() {
    const root = path.join(tmp, 'qtree-' + Math.random().toString(36).slice(2)); const T = F.writeTree(root)
    const db = newDb(); await ST.ingest(db, { dirsOverride: [root], ch: false })
    return { db, T, be: sqliteBe(db), prices: PR.parsePrices(null) }
}
test('attribution: by agent type, model, project, skill, tool; shares add up', async () => {
    const { be, prices, T } = await seeded()
    const at = await Q.breakdown(be, prices, 'agent_type')
    assert.deepEqual(at.rows.map((r) => r.key).sort(), ['builder', 'main'])
    assert.ok(Math.abs(at.rows.reduce((a, r) => a + r.share, 0) - 1) < 1e-9)
    const builder = at.rows.find((r) => r.key === 'builder')
    assert.equal(builder.output, 800); assert.equal(builder.cache_5m, 8000)
    const m = await Q.breakdown(be, prices, 'model'); assert.equal(m.rows.length, 2)
    assert.equal((await Q.breakdown(be, prices, 'project')).rows[0].key, 'demo-app')
    assert.equal((await Q.breakdown(be, prices, 'skill')).rows.some((r) => r.key === 'review'), true)
    const tl = await Q.breakdown(be, prices, 'tool'); const read = tl.rows.find((r) => r.key === 'Read')
    assert.equal(read.calls, 1); assert.equal(read.total, 10000); assert.equal(tl.estimated, true)
    await assert.rejects(Q.breakdown(be, prices, 'x; DROP'), /unknown dimension/)
    const ss = await Q.sessions(be, prices, { filter: { agent_type: 'builder' } }); assert.equal(ss.length, 1); assert.equal(ss[0].key, T.sess)
    const all = await Q.sessions(be, prices, {}); assert.equal(all[0].compactions, 1)
    assert.deepEqual(await Q.sessions(be, prices, { filter: { project: "o'x" } }), [])
})
test('totals and series: windows, fills gaps, cost uses the editable prices', async () => {
    const { be, prices, T } = await seeded()
    const t = await Q.totals(be, prices, T.t0 + 3_600_000)
    assert.equal(t.all.messages, 14); assert.ok(t.today.total > 0); assert.equal(t.all.total, t['30d'].total)
    const s = await Q.series(be, prices, { unit: 'hour' })
    assert.ok(s.buckets.length >= 1); assert.ok(Math.abs(s.buckets.reduce((a, b) => a + b.cost, 0) - t.all.cost) < 1e-9)
    assert.equal((await Q.series(be, prices, { unit: 'day' })).buckets.length, 1)
    const p2 = PR.parsePrices(JSON.stringify({ '*': { input: 0, output: 0, cache_read: 0, cache_5m: 0, cache_1h: 0 } }))
    assert.equal((await Q.totals(be, p2, T.t0)).all.cost, 0)
    await assert.rejects(Q.series(be, prices, { unit: 'week' }), /day or hour/)
})
test('insights: polling, big results, idle, compactions, fan-out each carry a suggestion', async () => {
    const { be, prices } = await seeded()
    const ins = await Q.insights(be, prices, { pollMin: 8, bigResultTokens: 8000 })
    const ids = ins.map((i) => i.id)
    for (const id of ['cache-read', 'big-results', 'polling', 'fan-out']) assert.ok(ids.includes(id), id)
    for (const i of ins) { assert.ok(i.suggestion && i.suggestion.length > 20); assert.ok(i.title) }
    assert.equal((await Q.insights(be, prices, { pollMin: 50 })).some((i) => i.id === 'polling'), false)
})
test('query dialects: ClickHouse SQL uses FINAL, db prefix and UTC helpers; strings escaped', async () => {
    const seen = []
    const be = { dialect: 'ch', db: 'nightly_usage', q: async (sql) => { seen.push(sql); return [] } }
    await Q.totals(be, PR.parsePrices(null)); await Q.series(be, PR.parsePrices(null), { unit: 'hour', since: 1000 })
    await Q.sessions(be, PR.parsePrices(null), { filter: { project: "a'b\\" } })
    assert.ok(seen.every((q) => /nightly_usage\.usage_\w+ FINAL/.test(q)))
    assert.ok(seen.some((q) => q.includes("formatDateTime(ts, '%Y-%m-%d %H:00', 'UTC')")))
    assert.ok(seen.some((q) => q.includes("project = 'a\\'b\\\\'")))
})
test('foldRuns sums the Nightly Run table', () => {
    const f = Q.foldRuns([{ startedAt: '2026-11-20T01:00:00Z', turns: 10, minutes: 5.5, costUsd: 1.25 }, { startedAt: new Date('2026-11-20T03:00:00Z'), turns: null, minutes: null, costUsd: 0.5 }, { startedAt: '2026-11-21T01:00:00Z', turns: 2, minutes: 1, costUsd: null }])
    assert.deepEqual(f.total, { runs: 3, turns: 12, minutes: 6.5, costUsd: 1.75 }); assert.equal(f.byDay.length, 2); assert.equal(f.byDay[0].runs, 2)
})
test('ClickHouse queries send prefer_column_name_to_alias (SUM(x) AS x aliases must not nest)', async () => {
    let url = ''
    const cfg = { url: 'http://x', user: 'u', password: '', db: 'd' }
    await CH.chQuery(cfg, 'SELECT 1', { fetchImpl: async (u) => { url = u; return { ok: true, status: 200, text: async () => '' } } })
    assert.match(url, /prefer_column_name_to_alias=1/)
})
// Live parity: runs only when a ClickHouse is reachable (NIGHTLY_CLICKHOUSE_URL or 127.0.0.1:8123 with the user/password env); uses a scratch database it drops.
test('live ClickHouse: every Usage query returns the same numbers as sqlite', async (t) => {
    const QU = await import('./usage-query.mjs')
    const base = CH.chConfig(() => null, process.env)
    const cfg = { ...base, db: `nightly_usage_test_${process.pid}`, enabled: true }
    try { await CH.chPing({ ...cfg, db: 'default' }) } catch { return t.skip('no ClickHouse reachable') }
    const root = path.join(tmp, 'livetree'); F.writeTree(root)
    const db = newDb()
    await ST.ingest(db, { dirsOverride: [root], ch: false })
    try {
        await ST.ensureCh(cfg)
        await ST.pushToCh(db, cfg)
        const prices = PR.parsePrices(null)
        const sq = { dialect: 'sqlite', q: async (sql) => db.prepare(sql).all() }
        const ch = { dialect: 'ch', db: cfg.db, q: (sql) => CH.chQuery(cfg, sql) }
        const norm = (x) => JSON.parse(JSON.stringify(x))
        for (const dim of [...Object.keys(QU.DIMS), 'tool']) assert.deepEqual(norm(await QU.breakdown(ch, prices, dim, {})), norm(await QU.breakdown(sq, prices, dim, {})), dim)
        const ins = await QU.insights(ch, prices, {}), ins2 = await QU.insights(sq, prices, {})
        assert.deepEqual(ins.map((i) => i.id).sort(), ins2.map((i) => i.id).sort())
        assert.equal((await QU.totals(ch, prices)).all.messages, (await QU.totals(sq, prices)).all.messages)
        assert.equal((await QU.sessions(ch, prices, {})).length, (await QU.sessions(sq, prices, {})).length)
    } finally { await CH.chCall({ ...cfg, db: 'default' }, {}, `DROP DATABASE IF EXISTS ${cfg.db}`) }
})
