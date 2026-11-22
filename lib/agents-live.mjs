// Keeping the agent board honest: heartbeats from any runner, automatic stale -> left, and agents that run but never registered.
//   live    = seen within LIVE_MINUTES
//   stale   = silent longer than that (shown as "gone quiet", their claims stop blocking)
//   left    = ended, or silent longer than the `agentLeftHours` setting (default 12): swept automatically, claims released
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import * as A from './agents.mjs'
import * as S from './store.mjs'

export const DEFAULT_LEFT_HOURS = 12
export const leftHours = (db) => Number(S.getSetting(db, 'agentLeftHours')) || DEFAULT_LEFT_HOURS

/** 'live' | 'stale' | 'left' for an Agent row. */
export function stateOf(a, { leftAfterHours = DEFAULT_LEFT_HOURS, at = Date.now() } = {}) {
    if (a.endedAt) return 'left'
    const age = at - Date.parse(a.lastSeenAt)
    return age < A.LIVE_MINUTES * 60_000 ? 'live' : age < leftAfterHours * 3600_000 ? 'stale' : 'left'
}

/** Any runner can call this on a timer: registers the agent on first sight, refreshes it afterwards. */
export function heartbeat(db, name, { kind = 'session', task, repos, runId } = {}) {
    const a = A.join(db, name, { kind, task, repos, runId })
    sweep(db)
    return a
}

/** Agents silent past the left threshold leave the board (claims released). Returns the names swept. */
export function sweep(db, { at = Date.now() } = {}) {
    const hours = leftHours(db)
    const swept = []
    for (const a of db.prepare('SELECT * FROM Agent WHERE endedAt IS NULL').all()) {
        if (stateOf(a, { leftAfterHours: hours, at }) !== 'left') continue
        A.leave(db, a, `no heartbeat for ${hours}h (auto)`)
        swept.push(a.name)
    }
    return swept
}

/** Parse the output of a source command or file: a JSON array of names / {name, task, since}, or one agent per line (`name  task...`). */
export function parseRunning(text) {
    const t = String(text).trim()
    if (!t) return []
    try {
        const j = JSON.parse(t)
        if (Array.isArray(j)) return j.map((x) => (typeof x === 'string' ? { name: x, task: '' } : { name: String(x.name ?? ''), task: String(x.task ?? ''), since: x.since ? String(x.since) : '' })).filter((x) => x.name)
    } catch { /* plain lines */ }
    return t.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [name, ...rest] = l.split(/\s+/); return { name, task: rest.join(' ') } })
}

/** Agents the configured source says are running that are not registered. Settings: `agentSourceCmd` (run with sh -c, 10 s) or `agentSourceFile`. */
export function unregistered(db) {
    const cmd = S.getSetting(db, 'agentSourceCmd'), file = S.getSetting(db, 'agentSourceFile')
    if (!cmd && !file) return { configured: false, agents: [] }
    let text = ''
    try { text = cmd ? execFileSync('sh', ['-c', cmd], { encoding: 'utf8', timeout: 10_000, maxBuffer: 1 << 20, stdio: ['ignore', 'pipe', 'ignore'] }) : fs.readFileSync(file, 'utf8') } catch (e) { return { configured: true, agents: [], error: String(e.message ?? e).split('\n')[0] } }
    const known = A.live(db).map((a) => a.name.toLowerCase())
    return { configured: true, agents: parseRunning(text).filter((x) => !known.includes(x.name.toLowerCase())) }
}
