// Usage tab queries. Pure: a backend { dialect: 'sqlite' | 'ch', db?, q(sql) -> rows } is passed in, so the same code runs on the
// local SQLite copy (panel through Prisma, CLI through node:sqlite) and on ClickHouse. All timestamps are UTC.
// Cost is computed here from token sums per (group, model) against the editable price table, so price edits apply to history.
import { cost, KINDS } from './usage-price.mjs'

export const DIMS = { project: 'project', session: 'session_id', agent_type: 'agent_type', model: 'model', skill: 'skill', branch: 'branch' }
const TOK = ['input', 'output', 'cache_read', 'cache_5m', 'cache_1h']
const SUMS = [...TOK, 'thinking'].map((k) => `SUM(${k}) AS ${k}`).join(', ')
const N = (v) => (typeof v === 'bigint' ? Number(v) : v === null || v === undefined ? 0 : Number(v))
const total = (t) => TOK.reduce((a, k) => a + N(t[k]), 0)

export function dialect(be) {
    const ch = be.dialect === 'ch'
    return {
        ch,
        t: (name) => (ch ? `${be.db}.${name} FINAL` : name),
        since: (ms) => (ms ? (ch ? `ts >= fromUnixTimestamp64Milli(toInt64(${Math.trunc(ms)}))` : `ts >= ${Math.trunc(ms)}`) : '1=1'),
        until: (ms) => (ms ? (ch ? `ts < fromUnixTimestamp64Milli(toInt64(${Math.trunc(ms)}))` : `ts < ${Math.trunc(ms)}`) : '1=1'),
        bucket: (unit) => {
            const f = unit === 'hour' ? { s: '%Y-%m-%d %H:00', c: '%Y-%m-%d %H:00' } : { s: '%Y-%m-%d', c: '%Y-%m-%d' }
            return ch ? `formatDateTime(ts, '${f.c}', 'UTC')` : `strftime('${f.s}', ts / 1000, 'unixepoch')`
        },
        ms: (col) => (ch ? `toUnixTimestamp64Milli(${col})` : col),
        lit: (s) => (ch ? `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : `'${String(s).replace(/'/g, "''")}'`),
    }
}

const sumRow = (r) => ({ input: N(r.input), output: N(r.output), cache_read: N(r.cache_read), cache_5m: N(r.cache_5m), cache_1h: N(r.cache_1h), thinking: N(r.thinking) })
const add = (a, b) => { for (const k of [...TOK, 'thinking']) a[k] = (a[k] ?? 0) + (b[k] ?? 0); return a }
const emptyT = () => ({ input: 0, output: 0, cache_read: 0, cache_5m: 0, cache_1h: 0, thinking: 0 })

/** Totals for each window: tokens by kind, messages, cost. */
export async function totals(be, prices, now = Date.now()) {
    const d = dialect(be), day = 86_400_000
    const startOfDay = now - (now % day)
    const windows = { today: startOfDay, '7d': now - 7 * day, '30d': now - 30 * day, all: 0 }
    const out = {}
    for (const [name, since] of Object.entries(windows)) {
        const rows = await be.q(`SELECT model, COUNT(*) AS messages, ${SUMS} FROM ${d.t('usage_message')} WHERE ${d.since(since)} GROUP BY model`)
        const t = emptyT(); let messages = 0, usd = 0
        for (const r of rows) { const s = sumRow(r); add(t, s); messages += N(r.messages); usd += cost(prices, r.model, s) }
        out[name] = { ...t, total: total(t), messages, cost: usd }
    }
    return out
}

/** Stacked series. unit 'day'|'hour'; returns { unit, buckets: [{ t, byKind:{}, byModel:{} (tokens), cost }] } with empty buckets filled in. */
export async function series(be, prices, { unit = 'day', since, until } = {}) {
    const d = dialect(be)
    if (unit !== 'day' && unit !== 'hour') throw new Error(`unit must be day or hour, got "${unit}"`)
    const rows = await be.q(`SELECT ${d.bucket(unit)} AS b, model, ${SUMS} FROM ${d.t('usage_message')} WHERE ${d.since(since)} AND ${d.until(until)} GROUP BY b, model ORDER BY b`)
    const map = new Map()
    for (const r of rows) {
        const s = sumRow(r), b = map.get(r.b) ?? { t: r.b, byKind: {}, byModel: {}, cost: 0 }
        for (const k of TOK) b.byKind[k] = (b.byKind[k] ?? 0) + s[k]
        b.byModel[r.model || '(unknown)'] = (b.byModel[r.model || '(unknown)'] ?? 0) + total(s)
        b.cost += cost(prices, r.model, s)
        map.set(r.b, b)
    }
    const keys = [...map.keys()].sort()
    const buckets = []
    if (keys.length) {
        const step = unit === 'hour' ? 3_600_000 : 86_400_000
        const parse = (k) => Date.parse(k.length === 10 ? k + 'T00:00:00Z' : k.replace(' ', 'T') + ':00Z')
        const fmt = (ms) => { const i = new Date(ms).toISOString(); return unit === 'hour' ? i.slice(0, 13).replace('T', ' ') + ':00' : i.slice(0, 10) }
        const a = parse(keys[0]), z = parse(keys[keys.length - 1])
        if ((z - a) / step > 5000) throw new Error('series too long: narrow the range')
        for (let t = a; t <= z; t += step) buckets.push(map.get(fmt(t)) ?? { t: fmt(t), byKind: {}, byModel: {}, cost: 0 })
    }
    return { unit, buckets }
}

/** Breakdown by a dimension (project, session, agent_type, model, skill, branch) or by tool. Rows: key, tokens by kind, total, cost, messages. */
export async function breakdown(be, prices, dim, { since, filter } = {}) {
    const d = dialect(be)
    if (dim === 'tool') return toolBreakdown(be, since, filter)
    const col = DIMS[dim] ?? (() => { throw new Error(`unknown dimension "${dim}" (one of: ${[...Object.keys(DIMS), 'tool'].join(', ')})`) })()
    const where = [d.since(since), ...filterSql(d, filter)].join(' AND ')
    const rows = await be.q(`SELECT ${col} AS k, model, COUNT(*) AS messages, ${SUMS}, ${d.ms('MIN(ts)')} AS first, ${d.ms('MAX(ts)')} AS last FROM ${d.t('usage_message')} WHERE ${where} GROUP BY k, model`)
    const map = new Map()
    for (const r of rows) {
        const key = String(r.k ?? ''), s = sumRow(r), e = map.get(key) ?? { key, ...emptyT(), messages: 0, cost: 0, first: Infinity, last: 0 }
        add(e, s); e.messages += N(r.messages); e.cost += cost(prices, r.model, s); e.first = Math.min(e.first, N(r.first)); e.last = Math.max(e.last, N(r.last))
        map.set(key, e)
    }
    const list = [...map.values()].map((e) => ({ ...e, total: total(e) }))
    const sum = list.reduce((a, e) => a + e.total, 0), usd = list.reduce((a, e) => a + e.cost, 0)
    return { dim, rows: list.map((e) => ({ ...e, key: e.key || '(none)', share: sum ? e.total / sum : 0, costShare: usd ? e.cost / usd : 0 })).sort((a, b) => b.total - a.total), total: sum, cost: usd }
}
const filterSql = (d, f) => Object.entries(f ?? {}).map(([k, v]) => {
    const col = k === 'tool' ? null : DIMS[k]
    if (!col) throw new Error(`cannot filter by "${k}"`)
    return `${col} = ${d.lit(v === '(none)' ? '' : v)}`
})

async function toolBreakdown(be, since, filter) {
    const d = dialect(be)
    const where = [d.since(since), ...filterSql(d, filter)].join(' AND ')
    const rows = await be.q(`SELECT tool AS k, COUNT(*) AS calls, SUM(result_tokens) AS result_tokens, MAX(result_tokens) AS biggest, SUM(is_error) AS errors FROM ${d.t('usage_tool')} WHERE ${where} GROUP BY k`)
    const sum = rows.reduce((a, r) => a + N(r.result_tokens), 0)
    return { dim: 'tool', estimated: true, total: sum, rows: rows.map((r) => ({ key: r.k, calls: N(r.calls), total: N(r.result_tokens), biggest: N(r.biggest), errors: N(r.errors), share: sum ? N(r.result_tokens) / sum : 0 })).sort((a, b) => b.total - a.total) }
}

/** Sessions (optionally filtered by a dimension value), newest first, with cost and compaction counts. */
export async function sessions(be, prices, { since, filter, limit = 50 } = {}) {
    const d = dialect(be)
    const where = [d.since(since), ...filterSql(d, filter)].join(' AND ')
    const rows = await be.q(`SELECT session_id AS k, model, COUNT(*) AS messages, MAX(project) AS project, MAX(branch) AS branch, SUM(sidechain) AS sub, ${SUMS}, ${d.ms('MIN(ts)')} AS first, ${d.ms('MAX(ts)')} AS last FROM ${d.t('usage_message')} WHERE ${where} GROUP BY k, model`)
    const map = new Map()
    for (const r of rows) {
        const s = sumRow(r), e = map.get(r.k) ?? { key: r.k, project: r.project, branch: r.branch, ...emptyT(), messages: 0, subMessages: 0, cost: 0, first: Infinity, last: 0 }
        add(e, s); e.messages += N(r.messages); e.subMessages += N(r.sub); e.cost += cost(prices, r.model, s); e.first = Math.min(e.first, N(r.first)); e.last = Math.max(e.last, N(r.last))
        map.set(r.k, e)
    }
    const ev = await be.q(`SELECT session_id AS k, COUNT(*) AS n FROM ${d.t('usage_event')} WHERE kind = 'compaction' AND ${d.since(since)} GROUP BY k`)
    const comp = new Map(ev.map((r) => [r.k, N(r.n)]))
    return [...map.values()].map((e) => ({ ...e, total: total(e), compactions: comp.get(e.key) ?? 0 })).sort((a, b) => b.last - a.last).slice(0, limit)
}

async function costWhere(be, prices, table, where) {
    const d = dialect(be)
    const rows = await be.q(`SELECT model, COUNT(*) AS messages, ${SUMS} FROM ${d.t(table)} WHERE ${where} GROUP BY model`)
    const t = emptyT(); let usd = 0, messages = 0
    for (const r of rows) { const s = sumRow(r); add(t, s); usd += cost(prices, r.model, s); messages += N(r.messages) }
    return { ...t, total: total(t), cost: usd, messages }
}

/**
 * "Where it goes": heuristic findings, each with a concrete suggestion. Thresholds are arguments (settings in the panel), never hidden.
 * Returns [{ id, level: 'warn'|'info', title, detail, suggestion, tokens?, cost? }] sorted by cost impact where known.
 */
export async function insights(be, prices, { since, pollMin = 8, bigResultTokens = 8000 } = {}) {
    const d = dialect(be), out = [], W = d.since(since)
    const all = await costWhere(be, prices, 'usage_message', W)
    if (!all.messages) return out
    const pct = (x) => `${Math.round(x * 100)}%`
    const fmt = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n))
    const usd = (x) => '$' + (x >= 100 ? Math.round(x) : x.toFixed(2))

    const ctx = all.input + all.cache_read + all.cache_5m + all.cache_1h
    const readShare = ctx ? all.cache_read / ctx : 1
    if (ctx > 1_000_000 && readShare < 0.7) out.push({ id: 'cache-read', level: 'warn', title: `Only ${pct(readShare)} of context was served from cache`,
        detail: `${fmt(all.input)} fresh input and ${fmt(all.cache_5m + all.cache_1h)} cache writes against ${fmt(all.cache_read)} cache reads.`,
        suggestion: 'Keep the prompt prefix stable (do not reorder or edit CLAUDE.md, skills or tool lists mid-session) and avoid long idle gaps: the 5 minute cache expires and the next call re-writes everything.' })
    else out.push({ id: 'cache-read', level: 'info', title: `${pct(readShare)} of context came from cache`, detail: `${fmt(all.cache_read)} cache reads vs ${fmt(all.input)} fresh input and ${fmt(all.cache_5m + all.cache_1h)} written.`, suggestion: 'Healthy. Cache reads are the cheapest input tokens; keep sessions long and the prefix stable.' })

    const writes = all.cache_5m + all.cache_1h
    if (all.cache_read > 0 && writes / all.cache_read > 0.25 && writes > 500_000) {
        const wc = cost(prices, '*', { cache_5m: all.cache_5m, cache_1h: all.cache_1h })
        out.push({ id: 'cache-churn', level: 'warn', title: 'Cache is rewritten often', detail: `${fmt(writes)} tokens written for ${fmt(all.cache_read)} read (about ${usd(wc)} of writes at default-family prices).`,
            suggestion: 'Many short sessions or pauses over 5 minutes rebuild the cache each time. Batch work into fewer, longer sessions, and use the 1 hour cache for agents that wake up on a slow cadence.', cost: wc })
    }

    const big = await be.q(`SELECT tool AS k, COUNT(*) AS n, SUM(result_tokens) AS tok, MAX(result_tokens) AS mx FROM ${d.t('usage_tool')} WHERE ${W} AND result_tokens >= ${Math.trunc(bigResultTokens)} GROUP BY k ORDER BY tok DESC LIMIT 5`)
    if (big.length) {
        const n = big.reduce((a, r) => a + N(r.n), 0), tok = big.reduce((a, r) => a + N(r.tok), 0)
        out.push({ id: 'big-results', level: 'warn', title: `${n} tool results over ${fmt(bigResultTokens)} tokens`,
            detail: big.map((r) => `${r.k}: ${N(r.n)} results, ${fmt(N(r.tok))} tokens, largest ${fmt(N(r.mx))} (estimated)`).join('; '),
            suggestion: 'Every later turn re-reads these from the context. Read files with offset/limit, grep before reading, pipe command output through head/tail, and have a subagent summarise big outputs instead of pasting them in.', tokens: tok })
    }

    const reread = await be.q(`SELECT COUNT(*) AS groups_, SUM(c) AS calls FROM (SELECT session_id, sig, COUNT(*) AS c FROM ${d.t('usage_tool')} WHERE ${W} AND tool = 'Read' GROUP BY session_id, sig HAVING COUNT(*) >= 3) x`)
    if (N(reread[0]?.groups_) > 0) out.push({ id: 're-reads', level: 'info', title: `${N(reread[0].groups_)} files read 3+ times in one session`, detail: `${N(reread[0].calls)} Read calls on the same file and range.`,
        suggestion: 'Repeated reads usually follow a compaction or an agent that forgot what it had. Note key facts in a scratch file, read narrower ranges, or keep the file open in a single long-lived agent.' })

    const poll = await be.q(`SELECT tool AS t, COUNT(*) AS loops, SUM(c) AS calls FROM (SELECT session_id, agent_id, tool, sig, COUNT(*) AS c FROM ${d.t('usage_tool')} WHERE ${W} GROUP BY session_id, agent_id, tool, sig HAVING COUNT(*) >= ${Math.trunc(pollMin)}) x GROUP BY t ORDER BY calls DESC LIMIT 5`)
    if (poll.length) {
        const calls = poll.reduce((a, r) => a + N(r.calls), 0)
        out.push({ id: 'polling', level: 'warn', title: `${calls} calls look like polling loops`, detail: poll.map((r) => `${r.t}: ${N(r.loops)} loops, ${N(r.calls)} identical calls`).join('; ') + ` (same input ${pollMin}+ times in one agent)`,
            suggestion: 'Each poll is a full model turn that re-reads the whole context. Replace polling with a blocking wait, a background task with a completion notification, or one longer sleep.' })
    }

    const idle = await costWhere(be, prices, 'usage_message', `${W} AND idle = 1`)
    if (idle.messages > 20 && idle.total / Math.max(1, all.total) > 0.03) out.push({ id: 'idle', level: 'warn', title: `${idle.messages} turns only waited (${pct(idle.total / all.total)} of tokens)`, detail: `Sleep, Monitor, TaskOutput and sleep-shell turns used ${fmt(idle.total)} tokens, about ${usd(idle.cost)}.`,
        suggestion: 'Idle agents still pay to re-read their context each wake-up. Stop idle agents, lengthen wake-up intervals, or end the session and restart when there is work.', tokens: idle.total, cost: idle.cost })

    const long = await costWhere(be, prices, 'usage_message', `${W} AND thinking >= 8000`)
    if (all.thinking > 0 && (all.thinking / Math.max(1, all.output) > 0.4 || long.messages >= 20)) out.push({ id: 'thinking', level: 'info', title: `Thinking is ${pct(all.thinking / Math.max(1, all.output))} of output`, detail: `${fmt(all.thinking)} thinking tokens; ${long.messages} turns spent 8k+ on thinking.`,
        suggestion: 'Thinking is billed as output, the priciest kind. Lower the thinking budget or effort for routine edits and keep deep thinking for planning.', tokens: all.thinking })

    const subs = await be.q(`SELECT agent_type AS k, model, COUNT(*) AS messages, ${SUMS} FROM ${d.t('usage_message')} WHERE ${W} AND sidechain = 1 GROUP BY k, model`)
    if (subs.length) {
        const by = new Map(); let sc = 0, st = 0
        for (const r of subs) { const s = sumRow(r), c = cost(prices, r.model, s); sc += c; st += total(s); by.set(r.k, (by.get(r.k) ?? 0) + c) }
        const share = all.cost ? sc / all.cost : 0
        const top = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, c]) => `${k} ${usd(c)}`).join(', ')
        out.push({ id: 'fan-out', level: share > 0.5 ? 'warn' : 'info', title: `Subagents account for ${pct(share)} of cost`, detail: `${usd(sc)} across subagent turns (${top}).`,
            suggestion: 'Each subagent starts with its own context. Give them narrow, self-contained prompts, use a cheaper model for mechanical work, and avoid spawning many agents for tiny tasks.', tokens: st, cost: sc })
    }

    const comp = await be.q(`SELECT COUNT(*) AS sessions_, SUM(c) AS n FROM (SELECT session_id, COUNT(*) AS c FROM ${d.t('usage_event')} WHERE kind = 'compaction' AND ${W} GROUP BY session_id HAVING COUNT(*) >= 2) x`)
    if (N(comp[0]?.sessions_) > 0) out.push({ id: 'compactions', level: 'warn', title: `${N(comp[0].sessions_)} sessions compacted 2+ times`, detail: `${N(comp[0].n)} compactions in total; each one re-writes the cache and loses detail.`,
        suggestion: 'Start a fresh session per task, hand work to subagents so the main context stays small, and write progress to files instead of relying on a long conversation.' })

    const avg = await be.q(`SELECT COUNT(*) AS n FROM (SELECT session_id, AVG(input + cache_read + cache_5m + cache_1h) AS a FROM ${d.t('usage_message')} WHERE ${W} AND sidechain = 0 GROUP BY session_id HAVING COUNT(*) >= 20 AND AVG(input + cache_read + cache_5m + cache_1h) > 150000) x`)
    if (N(avg[0]?.n) > 0) out.push({ id: 'big-context', level: 'info', title: `${N(avg[0].n)} sessions average over 150k tokens of context per turn`, detail: 'Every turn pays to read that context (cheaply when cached, but it adds up).',
        suggestion: 'Compact or restart earlier, trim large files out of the context, and move exploration to subagents.' })

    const models = await be.q(`SELECT model, ${SUMS} FROM ${d.t('usage_message')} WHERE ${W} GROUP BY model`)
    let top = { model: '', c: 0 }
    for (const r of models) { const c = cost(prices, r.model, sumRow(r)); if (c > top.c) top = { model: r.model, c } }
    if (all.cost > 0 && top.c / all.cost > 0.7 && /opus/i.test(top.model)) out.push({ id: 'model-mix', level: 'info', title: `${pct(top.c / all.cost)} of cost is ${top.model}`, detail: `${usd(top.c)} of ${usd(all.cost)}.`,
        suggestion: 'Route mechanical work (searching, formatting, test runs, simple edits) to a smaller model and keep the largest one for design and hard debugging.', cost: top.c })

    return out.sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || (a.level === 'warn' ? -1 : 1) - (b.level === 'warn' ? -1 : 1))
}

/** Nightly's own Run rows (turns, minutes, costUsd) folded by day and by item. Input rows: { startedAt, minutes, turns, costUsd } (the Run table; startedAt may be an ISO string or a Date). */
export function foldRuns(rows) {
    const byDay = new Map(); const t = { runs: 0, turns: 0, minutes: 0, costUsd: 0 }
    for (const r of rows) {
        const s = Date.parse(r.startedAt instanceof Date ? r.startedAt.toISOString() : r.startedAt), minutes = N(r.minutes)
        const day = Number.isFinite(s) ? new Date(s).toISOString().slice(0, 10) : '(unknown)'
        const x = byDay.get(day) ?? { day, runs: 0, turns: 0, minutes: 0, costUsd: 0 }
        for (const o of [x, t]) { o.runs++; o.turns += N(r.turns); o.minutes += minutes; o.costUsd += N(r.costUsd) }
        byDay.set(day, x)
    }
    return { total: t, byDay: [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)) }
}

export { KINDS }
