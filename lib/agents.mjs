// The agent board: Claude sessions working in the same workspace at the same time (the
// nightly run, live sessions) say who they are, claim the paths they are changing, and
// leave each other messages, so two of them never edit one repository unaware.
// An agent is identified by the name it joined with; every call refreshes lastSeenAt.
import fs from 'node:fs'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import * as S from './store.mjs'
import { OWNER } from './owner.mjs'

export const AGENT_KINDS = ['nightly', 'session']
/** Seen within this long = live. Older claims are shown as stale and do not block. */
export const LIVE_MINUTES = 60

const isLive = (a, at = Date.now()) => !a.endedAt && at - Date.parse(a.lastSeenAt) < LIVE_MINUTES * 60_000

/** `~/stack/website-city/src/` -> `website-city/src`. The workspace is the parent of this repo. */
const WORKSPACE = path.dirname(S.ROOT)
const TILDE = WORKSPACE.startsWith(os.homedir() + '/') ? '~' + WORKSPACE.slice(os.homedir().length) : null

export function normScope(s) {
    let x = String(s).trim().replace(/\\/g, '/')
    for (const prefix of [WORKSPACE, TILDE]) if (prefix && x.startsWith(prefix + '/')) x = x.slice(prefix.length + 1)
    x = x.replace(/^\.\//, '').replace(/\/+$/, '').replace(/\/{2,}/g, '/')
    return x || '*'
}

const repoOverlaps = (a, b) => a === '*' || b === '*' || a === b || a.startsWith(b + '/') || b.startsWith(a + '/')

/** Split a scope into its repo claim and optional path/glob: `host:repo:path` or `repo:path`.
 *  A leading `host:` (no slash before the first colon) belongs to the repo. A bare repo claim has path ''. */
export function splitScope(s) {
    const i = s.indexOf(':')
    if (i < 0) return { repo: s, path: '' }
    const j = /^[^/:]+$/.test(s.slice(0, i)) ? s.indexOf(':', i + 1) : i
    if (j < 0) return { repo: s, path: '' }
    return { repo: s.slice(0, j), path: s.slice(j + 1).replace(/^\/+|\/+$/g, '') }
}

const GLOB = /[*?[{]/
/** Directory-aligned literal prefix of a path pattern (everything before the first segment with a glob char). */
const litPrefix = (p) => {
    const segs = p.split('/'), k = segs.findIndex((x) => GLOB.test(x))
    return k < 0 ? p : segs.slice(0, k).join('/')
}
const related = (a, b) => a === b || a === '' || b === '' || a.startsWith(b + '/') || b.startsWith(a + '/')

/** Do two path patterns inside one repo possibly match a common file? Conservative: when unsure, yes. */
export function pathsOverlap(a, b) {
    if (!a || !b) return true
    const ga = GLOB.test(a), gb = GLOB.test(b)
    if (!ga && !gb) return related(a, b)
    if (ga !== gb) {
        const [lit, pat] = ga ? [b, a] : [a, b]
        const pre = litPrefix(pat)
        return path.matchesGlob(lit, pat) || pre === lit || pre.startsWith(lit + '/')
    }
    return related(litPrefix(a), litPrefix(b))
}

/** Two claims conflict when their repos overlap and, if both are path-scoped on the same repo, their paths overlap.
 *  A bare repo claim covers the whole repo. Scoped claims on nested-but-different repos are treated as conflicting. */
export function overlaps(a, b) {
    const x = splitScope(a), y = splitScope(b)
    if (!repoOverlaps(x.repo, y.repo)) return false
    if (!x.path || !y.path || x.repo !== y.repo) return true
    return pathsOverlap(x.path, y.path)
}

export const live = (db) => db.prepare('SELECT * FROM Agent WHERE endedAt IS NULL ORDER BY startedAt').all().filter((a) => isLive(a))

export function find(db, name) {
    return db.prepare('SELECT * FROM Agent WHERE name = ? AND endedAt IS NULL ORDER BY id DESC LIMIT 1').get(name)
}

export function must(db, name) {
    const a = find(db, name)
    if (!a) throw new Error(`no agent "${name}" on the board -- \`nightly agent join ${name} --task ".."\` first`)
    db.prepare('UPDATE Agent SET lastSeenAt = ? WHERE id = ?').run(S.now(), a.id)
    return { ...a, lastSeenAt: S.now() }
}

/** Join (or re-join: same name, still on the board) and return the agent row. */
export function join(db, name, { kind = 'session', task, repos, runId } = {}) {
    if (!/^[\w.@-]{1,40}$/.test(name)) throw new Error('agent name: 1-40 of letters, digits, . _ @ -')
    if (!AGENT_KINDS.includes(kind)) throw new Error(`bad kind "${kind}" (one of: ${AGENT_KINDS.join(', ')})`)
    const t = S.now()
    const cur = find(db, name)
    if (cur) {
        db.prepare('UPDATE Agent SET lastSeenAt = ?, task = COALESCE(?, task), repos = COALESCE(?, repos), runId = COALESCE(?, runId) WHERE id = ?')
            .run(t, task ?? null, repos ?? null, runId ?? null, cur.id)
        return db.prepare('SELECT * FROM Agent WHERE id = ?').get(cur.id)
    }
    // Start reading from now: a newcomer gets the board's recent history from `board`, not as unread mail.
    const last = db.prepare('SELECT COALESCE(MAX(id), 0) m FROM Message').get().m
    const r = db.prepare('INSERT INTO Agent (name, kind, task, repos, runId, lastReadId, startedAt, lastSeenAt) VALUES (?,?,?,?,?,?,?,?)')
        .run(name, kind, task ?? '', repos ?? '', runId ?? null, last, t, t)
    const a = db.prepare('SELECT * FROM Agent WHERE id = ?').get(Number(r.lastInsertRowid))
    post(db, a, `${name} joined${task ? `: ${task}` : ''}`, { author: 'board' })
    return a
}

export function activeClaims(db) {
    return db.prepare(`SELECT c.*, a.name, a.kind, a.lastSeenAt, a.endedAt FROM Claim c JOIN Agent a ON a.id = c.agentId
        WHERE c.releasedAt IS NULL ORDER BY c.createdAt`).all().map((c) => ({ ...c, stale: !isLive(c) }))
}

/** Claims by others that overlap `scope`. */
export function conflicts(db, scope, selfId = -1) {
    const s = normScope(scope)
    return activeClaims(db).filter((c) => c.agentId !== selfId && overlaps(c.scope, s))
}

// Relaunch guard (fleet-dup-launch-guard-1). Agents were relaunched on the same item again and again after the last
// one stopped with nothing committed (one item drew 13 agents). An agent's first claim names its item (--item,
// or an item key in its task); the claim is refused while another live agent works that item, or when the last agent
// on it left no commit evidence (a commit sha in its messages or leave note, or in the item's notes during its run; see SHAS below),
// unless --why says what changed. The refusal prints that agent's stop note.
// A sha is a 7-40 hex token with a digit; `daad107/faddf50` names two. Where the agent's repos are known (its claims,
// as checkouts in the workspace), a sha that resolves to a commit made before the agent started is no evidence: it is
// the base it was reading or a commit it reviewed ("nothing committed, worktree at 0de9e0d"). A token that resolves
// nowhere (another clone, a pushed branch not fetched here, or just a number) still counts: the guard refuses only on
// no evidence at all, so a doubt must not refuse a relaunch.
const HEX = '(?=[0-9a-f]*\\d)[0-9a-f]{7,40}'
const SHAS = new RegExp(`(?<![\\w./-])${HEX}(?:/${HEX})*(?![\\w/-])`, 'g')
export const shas = (text) => (String(text ?? '').match(SHAS) ?? []).flatMap((t) => t.split('/'))
/** Overridable in tests. Commit time in ms of `sha` in the git checkout `dir`, or null when it does not resolve. */
export const evidence = {
    commitTime(dir, sha) {
        const r = spawnSync('git', ['-c', 'safe.directory=*', '-C', dir, 'log', '-1', '--format=%ct', `${sha}^{commit}`, '--'],
            { encoding: 'utf8', timeout: 5000 })
        const t = r.status === 0 ? parseInt(r.stdout, 10) : NaN
        return Number.isFinite(t) ? t * 1000 : null
    },
    repoDirs(db, agentId) {
        const repos = db.prepare('SELECT DISTINCT scope FROM Claim WHERE agentId = ?').all(agentId).map((c) => splitScope(c.scope).repo)
        return [...new Set(repos)].filter((r) => r && r !== '*' && !/[*?[{]/.test(r))
            .flatMap((r) => path.isAbsolute(r) ? [r] : REPO_ROOTS.map((root) => path.join(root, r)))
            .filter((d) => fs.existsSync(path.join(d, '.git')))
    },
}
/** Where claimed repos are checked out: the workspace, then NIGHTLY_REPO_ROOTS (colon-separated; the Godot family by default). */
const REPO_ROOTS = [WORKSPACE, ...(process.env.NIGHTLY_REPO_ROOTS ?? '/home/gamedev/godot').split(':').filter(Boolean)]
const SLACK_MS = 5 * 60_000   // clock skew between boxes
/** Whether `text` names a commit the agent could have made: started at `since` in checkouts `dirs`. */
function namesCommit(text, dirs, since) {
    return shas(text).some((sha) => {
        const times = dirs.map((d) => evidence.commitTime(d, sha)).filter((t) => t !== null)
        return !times.length || times.some((t) => t >= since - SLACK_MS)
    })
}
const keyRe = (k) => new RegExp(`(^|[^\\w.-])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w-])`)

/** Item keys named in `text` that exist as work items (not checks). */
export function itemKeys(db, text) {
    const toks = [...new Set(String(text ?? '').match(/[a-z0-9][\w.-]*-\d+\b/gi) ?? [])]
    if (!toks.length) return []
    try {
        // A recurring check is run again and again and often commits nothing: the guard is for work items.
        return toks.filter((k) => db.prepare("SELECT 1 FROM Item WHERE key = ? AND kind != 'check'").get(k))
    } catch { return [] }   // a board without the Item table (tests, old databases)
}

/** The other agents on item `key`: { live: [...], last: the most recent ended one with its stop note and commits }. */
export function itemHistory(db, key, selfId = -1) {
    const re = keyRe(key)
    const rows = db.prepare('SELECT * FROM Agent WHERE id != ? AND task LIKE ? ORDER BY id DESC').all(selfId, `%${key}%`)
        .filter((a) => re.test(a.task))
    const live = rows.filter((a) => isLive(a))
    const prev = rows.find((a) => a.endedAt)
    if (!prev) return { live, last: null }
    const msgs = db.prepare('SELECT * FROM Message WHERE agentId = ? ORDER BY id').all(prev.id)
    const own = msgs.filter((m) => m.author !== 'board')
    const left = msgs.filter((m) => m.author === 'board' && m.body.startsWith(`${prev.name} left`)).at(-1)
    const stopNote = left ? left.body.slice(`${prev.name} left`.length).replace(/^:\s*/, '') : ''
    let notes = []
    try {
        notes = db.prepare('SELECT n.body FROM Note n JOIN Item i ON i.id = n.itemId WHERE i.key = ? AND n.createdAt >= ? AND n.createdAt <= ?')
            .all(key, prev.startedAt, new Date(Date.parse(prev.endedAt) + 10 * 60_000).toISOString()).map((n) => n.body)
    } catch { /* a board without the Note table */ }
    const dirs = evidence.repoDirs(db, prev.id), since = Date.parse(prev.startedAt)
    const committed = [...own.map((m) => m.body), stopNote, ...notes].some((t) => namesCommit(t, dirs, since))
    return { live, last: { ...prev, stopNote, committed } }
}

/** Why `agent` must not start on its item(s) yet, or [] (see the relaunch guard above). */
export function relaunchBlocks(db, agent) {
    const out = []
    for (const key of itemKeys(db, agent.task)) {
        const h = itemHistory(db, key, agent.id)
        for (const o of h.live) out.push({ key, why: 'live', agent: o })
        if (h.last && !h.last.committed) out.push({ key, why: 'no-commit', agent: h.last })
    }
    return out
}

/** Claim scopes for `agent`. Live conflicting claims stop it (nothing is claimed) unless force;
 *  stale ones are returned as warnings. An agent's first claim also passes the relaunch guard: `item` names its
 *  item (added to its task), `why` overrides a refusal and is posted to the board (force does not). */
export function claim(db, agent, scopes, { note = '', force = false, item = '', why = '' } = {}) {
    if (item && !keyRe(item).test(agent.task)) {
        const task = agent.task ? `${agent.task} (${item})` : item
        db.prepare('UPDATE Agent SET task = ? WHERE id = ?').run(task, agent.id)
        agent = { ...agent, task }
    }
    const first = !db.prepare('SELECT 1 FROM Claim WHERE agentId = ? LIMIT 1').get(agent.id)
    const relaunch = first ? relaunchBlocks(db, agent) : []
    if (relaunch.length && !why) return { ok: false, relaunch, blocking: [], stale: [], claimed: [] }
    const want = [...new Set(scopes.map(normScope))]
    const hits = want.flatMap((s) => conflicts(db, s, agent.id).map((c) => ({ ...c, wanted: s })))
    const blocking = hits.filter((c) => !c.stale)
    if (blocking.length && !force) return { ok: false, relaunch: [], blocking, stale: hits.filter((c) => c.stale), claimed: [] }
    if (relaunch.length) {
        post(db, agent, `${agent.name} starts ${[...new Set(relaunch.map((r) => r.key))].join(', ')} over the relaunch guard ` +
            `(${relaunch.map((r) => `${r.agent.name}: ${r.why}`).join(', ')}): ${why}`, { author: 'board' })
    }
    const t = S.now()
    const mine = new Set(db.prepare('SELECT scope FROM Claim WHERE agentId = ? AND releasedAt IS NULL').all(agent.id).map((r) => r.scope))
    const claimed = want.filter((s) => !mine.has(s))
    S.tx(db, () => {
        for (const s of claimed) db.prepare('INSERT INTO Claim (agentId, scope, note, createdAt) VALUES (?,?,?,?)').run(agent.id, s, note, t)
    })
    if (claimed.length) {
        const over = force && blocking.length ? ` (over ${[...new Set(blocking.map((c) => `${c.name}:${c.scope}`))].join(', ')} -- forced)` : ''
        post(db, agent, `${agent.name} claimed ${claimed.join(', ')}${note ? ` -- ${note}` : ''}${over}`, { author: 'board' })
    }
    return { ok: true, relaunch, blocking, stale: hits.filter((c) => c.stale), claimed }
}

/** Release some scopes (or all of them). Returns the scopes released. */
export function release(db, agent, scopes) {
    const rows = db.prepare('SELECT * FROM Claim WHERE agentId = ? AND releasedAt IS NULL').all(agent.id)
    const want = scopes?.length ? new Set(scopes.map(normScope)) : null
    const hit = rows.filter((r) => !want || want.has(r.scope))
    const t = S.now()
    for (const r of hit) db.prepare('UPDATE Claim SET releasedAt = ? WHERE id = ?').run(t, r.id)
    if (hit.length) post(db, agent, `${agent.name} released ${hit.map((r) => r.scope).join(', ')}`, { author: 'board' })
    return hit.map((r) => r.scope)
}

export function leave(db, agent, note) {
    const released = release(db, agent)
    db.prepare('UPDATE Agent SET endedAt = ? WHERE id = ?').run(S.now(), agent.id)
    post(db, agent, `${agent.name} left${note ? `: ${note}` : ''}`, { author: 'board' })
    return released
}

/** agent null = the owner / the system; author defaults to the agent's name. */
export function post(db, agent, body, { to = null, author } = {}) {
    const r = db.prepare('INSERT INTO Message (agentId, author, "to", body, createdAt) VALUES (?,?,?,?,?)')
        .run(agent?.id ?? null, author ?? agent?.name ?? OWNER, to, body, S.now())
    return db.prepare('SELECT * FROM Message WHERE id = ?').get(Number(r.lastInsertRowid))
}

/** Messages for `agent` it has not read: to everyone or to it, not its own, not board noise
 *  about itself. mark=true advances its read pointer. */
export function inbox(db, agent, { mark = true } = {}) {
    const rows = db.prepare(`SELECT * FROM Message WHERE id > ? AND (agentId IS NULL OR agentId != ?) AND ("to" IS NULL OR "to" = ?) ORDER BY id`)
        .all(agent.lastReadId, agent.id, agent.name)
    if (mark && rows.length) db.prepare('UPDATE Agent SET lastReadId = ? WHERE id = ?').run(rows.at(-1).id, agent.id)
    return rows
}

export const unread = (db, agent) =>
    db.prepare(`SELECT COUNT(*) n FROM Message WHERE id > ? AND (agentId IS NULL OR agentId != ?) AND ("to" IS NULL OR "to" = ?) AND author != 'board'`)
        .get(agent.lastReadId, agent.id, agent.name).n

export function board(db, { messages = 15 } = {}) {
    return {
        agents: live(db),
        claims: activeClaims(db),
        messages: db.prepare('SELECT * FROM Message ORDER BY id DESC LIMIT ?').all(messages).reverse(),
    }
}
