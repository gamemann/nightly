// The agent board: Claude sessions working in the same workspace at the same time (the
// nightly run, live sessions) say who they are, claim the paths they are changing, and
// leave each other messages, so two of them never edit one repository unaware.
// An agent is identified by the name it joined with; every call refreshes lastSeenAt.
import os from 'node:os'
import path from 'node:path'
import * as S from './store.mjs'

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

export const overlaps = (a, b) => a === '*' || b === '*' || a === b || a.startsWith(b + '/') || b.startsWith(a + '/')

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

/** Claim scopes for `agent`. Live conflicting claims stop it (nothing is claimed) unless force;
 *  stale ones are returned as warnings. */
export function claim(db, agent, scopes, { note = '', force = false } = {}) {
    const want = [...new Set(scopes.map(normScope))]
    const hits = want.flatMap((s) => conflicts(db, s, agent.id).map((c) => ({ ...c, wanted: s })))
    const blocking = hits.filter((c) => !c.stale)
    if (blocking.length && !force) return { ok: false, blocking, stale: hits.filter((c) => c.stale), claimed: [] }
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
    return { ok: true, blocking, stale: hits.filter((c) => c.stale), claimed }
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

/** agent null = Christian / the system; author defaults to the agent's name. */
export function post(db, agent, body, { to = null, author } = {}) {
    const r = db.prepare('INSERT INTO Message (agentId, author, "to", body, createdAt) VALUES (?,?,?,?,?)')
        .run(agent?.id ?? null, author ?? agent?.name ?? 'christian', to, body, S.now())
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
