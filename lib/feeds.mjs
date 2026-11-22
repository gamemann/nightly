// Project-health feeds: releases/deploys, crashes, web checks, playtests, content stats. One spec table drives the SQL, validation and CLI,
// so every feed has the same shape: add (upsert on its natural key), list, summary. Ingest HTTP -> `nightly feed add <kind> -` (Bearer token like perf).
// Web metrics are budgeted series; a sample over its budget opens an RSI finding (domain web), a later passing sample closes it.
// Content stats outside [min, max] do the same (domain content).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import * as S from './store.mjs'
import { ensure as ensureRsi, raise } from './rsi.mjs'

const MIGRATION = path.join(S.ROOT, 'prisma', 'migrations', '20261125000000_feeds', 'migration.sql')
export function ensure(db) {
    const sql = readFileSync(MIGRATION, 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    for (const st of sql.split(/;\s*(?:\n|$)/).map((x) => x.trim()).filter(Boolean)) db.exec(st)
}

// field types: s text, n number, i integer, t time (ISO). '!' = required.
export const FEEDS = {
    release: { table: 'Release', order: 'at DESC', key: ['repo', 'version', 'channel'], f: { game: 's', repo: 's!', version: 's!', channel: 's', commit: 's', ci: 's', deployedTo: 's', changelog: 's', rollback: 's', at: 't' },
        enums: { ci: ['unknown', 'pending', 'passing', 'failing'] } },
    crash: { table: 'CrashGroup', order: 'at DESC', key: ['game', 'signature', 'version', 'platform'], f: { game: 's!', signature: 's!', version: 's', platform: 's', count: 'i', sample: 's', status: 's', at: 't' },
        enums: { status: ['open', 'fixed', 'ignored'] } },
    web: { table: 'WebSample', order: 'at DESC, id DESC', key: null, f: { game: 's!', metric: 's!', value: 'n!', url: 's', commit: 's', at: 't' } },
    playtest: { table: 'Playtest', order: 'at DESC, id DESC', key: null, f: { game: 's!', build: 's', tester: 's', rating: 'i', tags: 's', text: 's', at: 't' } },
    content: { table: 'ContentStat', order: 'game, category, name', key: ['game', 'category', 'name', 'metric'], f: { game: 's!', category: 's', name: 's!', metric: 's!', value: 'n!', min: 'n', max: 'n', at: 't' } },
}
export const FEED_KINDS = Object.keys(FEEDS)
const ALIASES = { releases: 'release', deploys: 'release', crashes: 'crash', playtests: 'playtest', feedback: 'playtest' }
export const kindOf = (k) => { const v = ALIASES[k] ?? k; if (!FEEDS[v]) throw new Error(`unknown feed "${k}" (${FEED_KINDS.join(', ')})`); return v }

const MAX_TEXT = 20_000
function clean(spec, rec, at) {
    const out = {}
    for (const [name, t0] of Object.entries(spec.f)) {
        const req = t0.endsWith('!'), t = t0[0]
        let v = rec[name]
        if (name === 'at') v = v ?? at
        if (v === undefined || v === null || v === '') {
            if (req) throw new Error(`${name} is required`)
            continue
        }
        if (t === 's') v = String(v).slice(0, MAX_TEXT)
        else if (t === 'n' || t === 'i') { v = Number(v); if (!Number.isFinite(v)) throw new Error(`${name} must be a number`); if (t === 'i') v = Math.trunc(v) }
        else if (t === 't') { const d = new Date(v); if (Number.isNaN(d.getTime())) throw new Error(`${name} must be a date`); v = d.toISOString() }
        const allowed = spec.enums?.[name]
        if (allowed && !allowed.includes(v)) throw new Error(`${name} must be one of ${allowed.join('|')}`)
        out[name] = v
    }
    return out
}
const q = (n) => `"${n}"`

/** Add or update one record. Returns { id, created, ...extra } (extra: findings raised/closed). */
export function add(db, kind, rec, at = new Date()) {
    kind = kindOf(kind); ensure(db)
    const spec = FEEDS[kind], t = at.toISOString()
    const r = clean(spec, rec, t)
    if (kind === 'release' && !r.rollback) {
        const prev = db.prepare('SELECT version FROM Release WHERE repo = ? AND channel = ? AND version != ? ORDER BY at DESC, id DESC LIMIT 1').get(r.repo, r.channel ?? 'stable', r.version)
        if (prev) r.rollback = prev.version
    }
    if (kind === 'crash') { r.count ??= 1; r.version ??= ''; r.platform ??= '' }
    if (kind === 'content') r.category ??= ''
    if (kind === 'release') r.channel ??= 'stable'
    const existing = spec.key ? db.prepare(`SELECT * FROM ${q(spec.table)} WHERE ${spec.key.map((k) => `${q(k)} = ?`).join(' AND ')}`).get(...spec.key.map((k) => r[k] ?? '')) : null
    let id, created = !existing
    if (existing) {
        const patch = { ...r }
        if (kind === 'crash') { patch.count = existing.count + r.count; if (existing.status === 'fixed') patch.status = 'open' }
        for (const k of spec.key) delete patch[k]
        const cols = Object.keys(patch)
        if (cols.length) db.prepare(`UPDATE ${q(spec.table)} SET ${cols.map((c) => `${q(c)} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => patch[c]), existing.id)
        id = existing.id
    } else {
        const row = { ...r }
        if (kind === 'crash') row.firstSeenAt = r.at
        const cols = Object.keys(row)
        id = Number(db.prepare(`INSERT INTO ${q(spec.table)} (${cols.map(q).join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c])).lastInsertRowid)
    }
    const extra = kind === 'web' ? syncWeb(db, r.game, r.metric, t) : kind === 'content' ? syncContent(db, r.game, r, t) : {}
    return { id, created, ...extra }
}

/** Set (or change) a web budget: metric must stay at or under max. */
export function setBudget(db, game, metric, max, unit = '') {
    ensure(db)
    if (!game || !metric || !Number.isFinite(Number(max))) throw new Error('web budget needs --game, --metric and --max')
    db.prepare('INSERT INTO "WebBudget" (game, metric, max, unit) VALUES (?,?,?,?) ON CONFLICT(game, metric) DO UPDATE SET max = excluded.max, unit = excluded.unit').run(game, metric, Number(max), unit)
    return { game, metric, max: Number(max), unit }
}
export const budgets = (db, game) => { ensure(db); return db.prepare(`SELECT * FROM "WebBudget" ${game ? 'WHERE game = ?' : ''} ORDER BY game, metric`).all(...(game ? [game] : [])) }

function gateFinding(db, domain, subject, code, bad, msg, nextAction, t) {
    ensureRsi(db)
    if (bad) { raise(db, { domain, subject, code, tier: '', severity: 'warn', score: null, msg, nextAction, itemKey: '' }, t); return { raised: 1 } }
    const r = db.prepare("UPDATE RsiFinding SET status='resolved', state='remeasured', fixedAt=?, lastSeenAt=?, nextAction='Within budget: nothing to do' WHERE domain=? AND subject=? AND code=? AND status='open'").run(t, t, domain, subject, code)
    return { closed: Number(r.changes) }
}
function syncWeb(db, game, metric, t) {
    const b = db.prepare('SELECT * FROM "WebBudget" WHERE game = ? AND metric = ?').get(game, metric)
    if (!b) return {}
    const last = db.prepare('SELECT value FROM "WebSample" WHERE game = ? AND metric = ? ORDER BY at DESC, id DESC LIMIT 1').get(game, metric)
    return gateFinding(db, 'web', game, metric, last.value > b.max, `${metric} ${last.value}${b.unit} is over its budget of ${b.max}${b.unit}`,
        'Find what grew (bundle diff, new asset, slow endpoint) and fix it; raise the budget only when the growth is intended and say why on the item', t)
}
function syncContent(db, game, r, t) {
    if (r.min == null && r.max == null) return {}
    const out = r.value < (r.min ?? -Infinity) || r.value > (r.max ?? Infinity)
    const subject = `${game}/${r.category ? r.category + '/' : ''}${r.name}`
    return gateFinding(db, 'content', subject, r.metric, out, `${r.metric} ${r.value} is outside [${r.min ?? '-'}, ${r.max ?? '-'}]`,
        'Rebalance the content, or widen the range if the new value is intended (and note why)', t)
}

export function list(db, kind, { game, limit = 50, status } = {}) {
    kind = kindOf(kind); ensure(db)
    const spec = FEEDS[kind], w = [], a = []
    if (game) { w.push('game = ?'); a.push(game) }
    if (status && spec.f.status) { w.push('status = ?'); a.push(status) }
    return db.prepare(`SELECT * FROM ${q(spec.table)} ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY ${spec.order} LIMIT ?`).all(...a, limit)
}

/** Record a deploy: the release is created if new and the environment is added to deployedTo. */
export function deploy(db, { repo, version, to, channel = 'stable', game = '' }, at = new Date()) {
    ensure(db)
    if (!repo || !version || !to) throw new Error('deploy needs --repo, --version and --to')
    const cur = db.prepare('SELECT deployedTo FROM "Release" WHERE repo = ? AND version = ? AND channel = ?').get(repo, version, channel)
    const envs = new Set(String(cur?.deployedTo ?? '').split(',').map((s) => s.trim()).filter(Boolean)); envs.add(to)
    // one version per environment: move the marker off older releases of this repo
    for (const r of db.prepare('SELECT id, deployedTo FROM "Release" WHERE repo = ? AND channel = ? AND version != ?').all(repo, channel, version)) {
        const keep = r.deployedTo.split(',').map((s) => s.trim()).filter((s) => s && s !== to).join(',')
        if (keep !== r.deployedTo) db.prepare('UPDATE "Release" SET deployedTo = ? WHERE id = ?').run(keep, r.id)
    }
    return add(db, 'release', { repo, version, channel, game, deployedTo: [...envs].join(',') }, at)
}

/** Per-kind headline numbers for the pages and `summary`. */
export function summary(db, kind, game) {
    kind = kindOf(kind); ensure(db)
    const g = game ? ' WHERE game = ?' : '', a = game ? [game] : []
    if (kind === 'crash') return db.prepare(`SELECT version, platform, COUNT(*) AS signatures, SUM(count) AS crashes FROM "CrashGroup" WHERE status = 'open'${game ? ' AND game = ?' : ''} GROUP BY version, platform ORDER BY crashes DESC`).all(...a)
    if (kind === 'playtest') return db.prepare(`SELECT build, COUNT(*) AS n, ROUND(AVG(rating), 2) AS avgRating FROM "Playtest"${g} GROUP BY build ORDER BY MAX(at) DESC`).all(...a)
    if (kind === 'web') return db.prepare(`SELECT s.game, s.metric, s.value, b.max, b.unit, s.at FROM "WebSample" s LEFT JOIN "WebBudget" b ON b.game = s.game AND b.metric = s.metric
        WHERE s.id = (SELECT id FROM "WebSample" WHERE game = s.game AND metric = s.metric ORDER BY at DESC, id DESC LIMIT 1)${game ? ' AND s.game = ?' : ''} ORDER BY s.game, s.metric`).all(...a)
    return { count: db.prepare(`SELECT COUNT(*) n FROM ${q(FEEDS[kind].table)}${g}`).get(...a).n }
}
