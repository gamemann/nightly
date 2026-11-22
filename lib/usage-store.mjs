// USAGE tab, the database side (CLI, node:sqlite). The panel only READS these tables (through Prisma raw SQL); every write is here.
// Tables hold counts, ids and names, never message text. SQLite is the local copy (and the tab's fallback); ClickHouse, when
// configured, mirrors the same rows (usage-ch.mjs) with the same column names.
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as S from './store.mjs'
import { parseTranscript } from './usage-parse.mjs'
import { parsePrices } from './usage-price.mjs'
import { CH_TABLES, chCall, chConfig, chInsert } from './usage-ch.mjs'

export const MSG_COLS = ['msg_key', 'ts', 'session_id', 'agent_id', 'agent_type', 'sidechain', 'project', 'branch', 'model', 'input', 'output', 'cache_read', 'cache_5m', 'cache_1h', 'thinking', 'tools', 'stop_reason', 'request_id', 'skill', 'idle', 'ver']
export const TOOL_COLS = ['tool_use_id', 'ts', 'session_id', 'agent_id', 'agent_type', 'project', 'model', 'tool', 'sig', 'result_tokens', 'is_error', 'skill', 'ver']
export const EVENT_COLS = ['event_key', 'ts', 'kind', 'session_id', 'agent_id', 'project', 'ver']
const COLS = { usage_message: MSG_COLS, usage_tool: TOOL_COLS, usage_event: EVENT_COLS }

/** Settings with their defaults. 0 means unlimited/off where it makes sense; nothing is capped silently. */
export const SETTINGS = {
    usageDirs: '',                  // transcript directories, one per line or comma separated (~ allowed); blank = ~/.claude/projects
    usageProjectMode: 'basename',   // project label: basename | hash | none (hash and none redact the repository name)
    usageAutoIngestMinutes: 0,      // `nightly tick` ingests when the last ingest is older than this many minutes; 0 = only by hand
    usagePollMin: 8,                // the same tool call (same input) repeated this many times in one agent counts as a polling loop
    usageBigResultTokens: 8000,     // a tool result this large (estimated tokens) is listed as a big context
    usageChBatch: 5000,             // rows per ClickHouse insert
}
export const setting = (db, k) => {
    const v = S.getSetting(db, k)
    if (typeof SETTINGS[k] !== 'number') return v === null || v === '' ? SETTINGS[k] : v
    const n = v === null || v === '' ? SETTINGS[k] : Number(v)
    if (!Number.isFinite(n) || n < 0) throw new Error(`setting ${k} must be a number >= 0, got "${v}"`)
    return n
}
export const prices = (db) => parsePrices(S.getSetting(db, 'usagePrices'))
export const chConfigFrom = (db) => chConfig((k) => S.getSetting(db, k))
export function dirs(db, env = process.env) {
    const raw = S.getSetting(db, 'usageDirs') || env.NIGHTLY_USAGE_DIRS || ''
    const list = raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean).map((d) => (d === '~' || d.startsWith('~/') ? path.join(os.homedir(), d.slice(1)) : d))
    return list.length ? list : [path.join(os.homedir(), '.claude', 'projects')]
}

export function ensure(db) {
    db.exec(`
CREATE TABLE IF NOT EXISTS usage_message (msg_key TEXT PRIMARY KEY, ts INTEGER NOT NULL, session_id TEXT NOT NULL DEFAULT '', agent_id TEXT NOT NULL DEFAULT '', agent_type TEXT NOT NULL DEFAULT 'main',
  sidechain INTEGER NOT NULL DEFAULT 0, project TEXT NOT NULL DEFAULT '', branch TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0, cache_5m INTEGER NOT NULL DEFAULT 0, cache_1h INTEGER NOT NULL DEFAULT 0, thinking INTEGER NOT NULL DEFAULT 0, tools TEXT NOT NULL DEFAULT '[]',
  stop_reason TEXT NOT NULL DEFAULT '', request_id TEXT NOT NULL DEFAULT '', skill TEXT NOT NULL DEFAULT '', idle INTEGER NOT NULL DEFAULT 0, ver INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS usage_message_ts ON usage_message (ts);
CREATE INDEX IF NOT EXISTS usage_message_session ON usage_message (session_id);
CREATE INDEX IF NOT EXISTS usage_message_ver ON usage_message (ver);
CREATE TABLE IF NOT EXISTS usage_tool (tool_use_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, session_id TEXT NOT NULL DEFAULT '', agent_id TEXT NOT NULL DEFAULT '', agent_type TEXT NOT NULL DEFAULT 'main',
  project TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', tool TEXT NOT NULL DEFAULT '', sig TEXT NOT NULL DEFAULT '', result_tokens INTEGER NOT NULL DEFAULT 0, is_error INTEGER NOT NULL DEFAULT 0,
  skill TEXT NOT NULL DEFAULT '', ver INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS usage_tool_ts ON usage_tool (ts);
CREATE INDEX IF NOT EXISTS usage_tool_session ON usage_tool (session_id);
CREATE INDEX IF NOT EXISTS usage_tool_ver ON usage_tool (ver);
CREATE TABLE IF NOT EXISTS usage_event (event_key TEXT PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '', agent_id TEXT NOT NULL DEFAULT '', project TEXT NOT NULL DEFAULT '', ver INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS usage_event_ver ON usage_event (ver);
CREATE TABLE IF NOT EXISTS usage_agent (session_id TEXT NOT NULL, agent_id TEXT NOT NULL, agent_type TEXT NOT NULL, PRIMARY KEY (session_id, agent_id));
CREATE TABLE IF NOT EXISTS usage_spawn (tool_use_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, subagent_type TEXT NOT NULL, agent_id TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS usage_file (path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, offset INTEGER NOT NULL, state TEXT NOT NULL DEFAULT '{}');`)
}

/** Transcript files under one projects dir: main sessions first, then subagent files (their types are learned from the main ones). */
export function discover(dir) {
    const main = [], side = []
    const ls = (p) => { try { return readdirSync(p, { withFileTypes: true }) } catch { return null } }
    const top = ls(dir)
    if (!top) return { main, side, unreadable: 1 }
    let unreadable = 0
    for (const proj of top) {
        if (!proj.isDirectory()) continue
        const pd = path.join(dir, proj.name), fallback = proj.name.replace(/^-+/, '').split('-').pop() || proj.name
        const ents = ls(pd)
        if (!ents) { unreadable++; continue }
        for (const e of ents) {
            if (e.isFile() && e.name.endsWith('.jsonl')) main.push({ file: path.join(pd, e.name), sessionId: e.name.slice(0, -6), agentId: '', sidechain: false, fallback })
            else if (e.isDirectory()) {
                const sd = path.join(pd, e.name, 'subagents'), subs = ls(sd)
                for (const s of subs ?? []) {
                    if (!s.isFile() || !s.name.endsWith('.jsonl')) continue
                    let agentType = ''
                    try { agentType = String(JSON.parse(readFileSync(path.join(sd, s.name.slice(0, -6) + '.meta.json'), 'utf8')).agentType || '') } catch { /* no meta: learned from the spawning call */ }
                    side.push({ file: path.join(sd, s.name), sessionId: e.name, agentId: s.name.replace(/^agent-/, '').slice(0, -6), sidechain: true, agentType, fallback })
                }
            }
        }
    }
    return { main, side, unreadable }
}

const same = (a, b, cols) => cols.every((c) => c === 'ver' || String(a[c]) === String(b[c]))

/** Read new complete lines of one file, parse and upsert. Returns counters, or null when the file is unchanged. */
function ingestFile(db, f, o) {
    let fd
    try { fd = openSync(f.file, 'r') } catch { return { unreadable: 1 } }
    try {
        const st = fstatSync(fd)
        const row = db.prepare('SELECT * FROM usage_file WHERE path = ?').get(f.file)
        let offset = row?.offset ?? 0, state = {}
        if (row && !o.full && row.size === st.size && row.mtime_ms === Math.trunc(st.mtimeMs)) return null
        if (!row || o.full || st.size < offset) offset = 0; else state = JSON.parse(row.state || '{}')
        const buf = Buffer.alloc(st.size - offset)
        readSync(fd, buf, 0, buf.length, offset)
        const end = buf.lastIndexOf(10) + 1                    // only whole lines; a half-written tail waits for the next run
        const text = buf.subarray(0, end).toString('utf8')
        const r = parseTranscript(text, { sessionId: f.sessionId, agentId: f.agentId, sidechain: f.sidechain, agentType: f.agentType, projectMode: o.projectMode, fallbackProject: f.fallback, state })
        const c = { messages: 0, tools: 0, events: 0, bytes: end }
        db.exec('BEGIN')
        try {
            const getM = db.prepare('SELECT * FROM usage_message WHERE msg_key = ?')
            const putM = db.prepare(`INSERT OR REPLACE INTO usage_message (${MSG_COLS.join(',')}) VALUES (${MSG_COLS.map(() => '?').join(',')})`)
            for (const m of r.messages.values()) {
                const old = getM.get(m.msg_key)
                let row2 = m
                if (old) {
                    const oldTools = JSON.parse(old.tools || '[]')
                    row2 = { ...m, tools: [...new Set([...oldTools, ...m.tools])] }
                    if (old.output > m.output) Object.assign(row2, { input: old.input, output: old.output, cache_read: old.cache_read, cache_5m: old.cache_5m, cache_1h: old.cache_1h, thinking: old.thinking, ts: old.ts })
                }
                const cand = { ...row2, tools: JSON.stringify(row2.tools) }
                if (old && same(old, cand, MSG_COLS)) continue
                putM.run(...MSG_COLS.map((k) => (k === 'ver' ? o.ver() : cand[k])))
                c.messages++
            }
            const getT = db.prepare('SELECT * FROM usage_tool WHERE tool_use_id = ?')
            const putT = db.prepare(`INSERT OR REPLACE INTO usage_tool (${TOOL_COLS.join(',')}) VALUES (${TOOL_COLS.map(() => '?').join(',')})`)
            for (const t of r.tools.values()) {
                const old = getT.get(t.tool_use_id)
                const cand = { ...t, ...(old && !t.has_result ? { result_tokens: old.result_tokens, is_error: old.is_error } : {}) }
                if (old && same(old, cand, TOOL_COLS)) continue
                putT.run(...TOOL_COLS.map((k) => (k === 'ver' ? o.ver() : cand[k])))
                c.tools++
            }
            const setR = db.prepare('UPDATE usage_tool SET result_tokens = ?, is_error = ?, ver = ? WHERE tool_use_id = ? AND (result_tokens != ? OR is_error != ?)')
            for (const x of r.results) c.tools += Number(setR.run(x.tokens, x.is_error, o.ver(), x.tool_use_id, x.tokens, x.is_error).changes)
            const putE = db.prepare('INSERT OR IGNORE INTO usage_event (event_key, ts, kind, session_id, agent_id, project, ver) VALUES (?,?,?,?,?,?,?)')
            for (const e of r.events) c.events += Number(putE.run(e.key, e.ts, e.kind, e.session_id, e.agent_id, e.project, o.ver()).changes)
            const putS = db.prepare('INSERT INTO usage_spawn (tool_use_id, session_id, subagent_type) VALUES (?,?,?) ON CONFLICT(tool_use_id) DO UPDATE SET subagent_type = excluded.subagent_type')
            for (const s of r.spawns) putS.run(s.tool_use_id, f.sessionId, s.subagent_type)
            const link = db.prepare('UPDATE usage_spawn SET agent_id = ? WHERE tool_use_id = ?')
            for (const l of r.links) link.run(l.agent_id, l.tool_use_id)
            if (f.sidechain && f.agentType) db.prepare('INSERT OR REPLACE INTO usage_agent (session_id, agent_id, agent_type) VALUES (?,?,?)').run(f.sessionId, f.agentId, f.agentType)
            db.prepare('INSERT OR REPLACE INTO usage_file (path, size, mtime_ms, offset, state) VALUES (?,?,?,?,?)').run(f.file, st.size, Math.trunc(st.mtimeMs), offset + end, JSON.stringify(r.state))
            db.exec('COMMIT')
        } catch (e) { db.exec('ROLLBACK'); throw e }
        return c
    } finally { closeSync(fd) }
}

/** Subagent rows whose type was not in a meta file get it from the Agent/Task call that spawned them. */
function resolveAgents(db, ver) {
    const rows = db.prepare("SELECT session_id, agent_id, subagent_type FROM usage_spawn WHERE agent_id != ''").all()
    const put = db.prepare('INSERT OR REPLACE INTO usage_agent (session_id, agent_id, agent_type) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM usage_agent WHERE session_id = ? AND agent_id = ?)')
    let fixed = 0
    for (const r of rows) {
        put.run(r.session_id, r.agent_id, r.subagent_type, r.session_id, r.agent_id)
        for (const t of ['usage_message', 'usage_tool']) {
            fixed += Number(db.prepare(`UPDATE ${t} SET agent_type = ?, ver = ? WHERE session_id = ? AND agent_id = ? AND agent_type = 'subagent'`).run(r.subagent_type, ver(), r.session_id, r.agent_id).changes)
        }
    }
    return fixed
}

const iso = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '')
/** Push every row written since the last push (per-table watermark on `ver`) to ClickHouse. Idempotent: ReplacingMergeTree keeps the highest ver. */
export async function pushToCh(db, cfg, { fetchImpl, resync = false } = {}) {
    const out = {}
    for (const t of CH_TABLES) {
        const wmKey = `usageChWm_${t}`
        let wm = resync ? 0 : Number(S.getSetting(db, wmKey) ?? 0)
        let n = 0
        for (;;) {
            const rows = db.prepare(`SELECT * FROM ${t} WHERE ver > ? ORDER BY ver LIMIT ?`).all(wm, cfg.batch)
            if (!rows.length) break
            const conv = rows.map((r) => ({ ...r, ts: iso(r.ts), ...(r.tools !== undefined ? { tools: JSON.parse(r.tools) } : {}) }))
            n += await chInsert(cfg, t, conv, { fetchImpl })
            wm = rows[rows.length - 1].ver
            S.setSetting(db, wmKey, wm)
        }
        out[t] = n
    }
    return out
}

export async function ensureCh(cfg, { fetchImpl } = {}) {
    const sql = readFileSync(path.join(S.ROOT, 'deploy', 'clickhouse', 'schema.sql'), 'utf8').replace(/\{db\}/g, cfg.db)
    const stmts = sql.replace(/^\s*--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean)
    for (const s of stmts) await chCall({ ...cfg, db: 'default' }, {}, s, { fetchImpl })
    return stmts.length
}

/** Scan the configured directories and ingest what changed. `ch` pushes to ClickHouse afterwards when it is configured. */
export async function ingest(db, { full = false, dirsOverride, ch = true, fetchImpl, resync = false, now = Date.now() } = {}) {
    ensure(db)
    const maxVer = Math.max(...['usage_message', 'usage_tool', 'usage_event'].map((t) => db.prepare(`SELECT COALESCE(MAX(ver),0) v FROM ${t}`).get().v))
    let last = Math.max(now * 1000, maxVer + 1)
    const o = { full, projectMode: setting(db, 'usageProjectMode'), ver: () => last++ }
    const stats = { dirs: 0, files: 0, changed: 0, unreadable: 0, messages: 0, tools: 0, events: 0, bytes: 0, agentTypesFixed: 0, ch: null, chError: null }
    const files = []
    for (const d of dirsOverride?.length ? dirsOverride : dirs(db)) {
        if (!existsSync(d)) { stats.unreadable++; continue }
        const f = discover(d)
        stats.dirs++; stats.unreadable += f.unreadable
        files.push(...f.main, ...f.side)
    }
    files.sort((a, b) => Number(a.sidechain) - Number(b.sidechain))
    for (const f of files) {
        stats.files++
        const r = ingestFile(db, f, o)
        if (!r) continue
        if (r.unreadable) { stats.unreadable++; continue }
        stats.changed++
        for (const k of ['messages', 'tools', 'events', 'bytes']) stats[k] += r[k]
    }
    stats.agentTypesFixed = resolveAgents(db, o.ver)
    S.setSetting(db, 'usageLastIngestAt', new Date(now).toISOString())
    if (ch) {
        const cfg = chConfigFrom(db)
        if (cfg.enabled) {
            try { stats.ch = await pushToCh(db, cfg, { fetchImpl, resync }) } catch (e) { stats.chError = e.message }
        }
    }
    return stats
}

/** `nightly tick` hook: ingest when usageAutoIngestMinutes is set and the last ingest is older. Returns log lines. */
export async function tickHook(db, now = Date.now()) {
    const every = setting(db, 'usageAutoIngestMinutes')
    if (!every) return []
    const last = Date.parse(S.getSetting(db, 'usageLastIngestAt') ?? '')
    if (Number.isFinite(last) && now - last < every * 60_000) return []
    const s = await ingest(db, { now })
    return [`usage: ${s.changed}/${s.files} files, ${s.messages} messages${s.chError ? `, clickhouse: ${s.chError}` : ''}`]
}
