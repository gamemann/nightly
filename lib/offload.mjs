// Offload seam: run work "somewhere" (a Planet or Station). The Nodes builder registers a remote transport with setOffloadRemote();
// without one (or for target 'planet'/'local') the job runs on this machine, detached, so it outlives the panel request.
//   runOffload({ kind: 'playtest', project, target, params, requestedBy }) -> { id, node, status }   one offload_job row, status queued|running|ok|failed|error
//   nightly offload run <id> is the detached child that executes a local job (lib/ops-cli.mjs).
// Station jobs: the panel (src/server/nodeManager.ts) asks the node scheduler first. When a station offers the
// 'playtest' kind it creates the row with `node` (no local child), queues a NodeJob running playtestCommand() in
// the project's checkout on that node, then reports back with `nightly offload mark|finish` (markJob/finishJob).
// With no capable station the row runs here as before, with a note in its log.
// kind 'playtest': <repoPath>/tools/playtest.sh [--map M] [--bots N] [--duration S] (project setting playtestScript overrides the path); its SOAK line is parsed
// (lib/playtest-bots.mjs) and recorded as a bot playtest of the game; the job's log is the script output (tail).
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensure } from './ops-store.mjs'
import * as PB from './playtest-bots.mjs'

export const KINDS = ['playtest']
export const TARGETS = ['planet', 'station']
const LOG_MAX = 200_000
let remote = null
/** fn(job) -> { accepted: true, node } | false. Called for targets other than 'planet'; false falls back to local. */
export const setOffloadRemote = (fn) => { remote = typeof fn === 'function' ? fn : null }

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : d }
export const cleanParams = (p = {}) => ({ map: String(p.map ?? '').replace(/[^\w.\-]/g, '').slice(0, 60), bots: num(p.bots, 4), duration: num(p.duration, 120), mode: String(p.mode ?? '').replace(/[^\w.\-]/g, '').slice(0, 30) })

/** Arguments of tools/playtest.sh for these params (local and remote runs use the same). */
export const playtestArgs = (p) => [...(p.map ? ['--map', p.map] : []), '--bots', String(p.bots ?? 4), '--duration', String(p.duration ?? 120)]
/** Shell command a node runs in the project's checkout. Params are already cleaned (word characters only). */
export const playtestCommand = (params) => ['bash', 'tools/playtest.sh', ...playtestArgs(cleanParams(params))].join(' ')

export function runOffload(db, { kind, project, target = 'planet', params = {}, requestedBy = '', spawnChild = true, node = '' } = {}) {
    if (!KINDS.includes(kind)) throw new Error(`unknown offload kind "${kind}" (${KINDS.join(', ')})`)
    if (!project) throw new Error('project required')
    if (!TARGETS.includes(target)) throw new Error(`target must be one of ${TARGETS.join(', ')}`)
    ensure(db)
    const p = cleanParams(params)
    const now = Date.now()
    const id = Number(db.prepare('INSERT INTO offload_job (kind, project, target, node, params, status, requested_by, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(kind, String(project), target, 'local', JSON.stringify(p), 'queued', String(requestedBy), now).lastInsertRowid)
    if (node) {
        // The panel's node scheduler took it: no local child; it reports back with markJob/finishJob.
        const name = String(node).replace(/[^\w.:-]/g, '').slice(0, 60) || 'station'
        db.prepare('UPDATE offload_job SET node = ? WHERE id = ?').run(name, id)
        appendLog(db, id, `queued for ${name} by the node scheduler`)
        return { id, node: name, status: 'queued', command: playtestCommand(p) }
    }
    if (target !== 'planet' && remote) {
        let r = false
        try { r = remote({ id, kind, project, target, params: p, requestedBy }) } catch (e) { appendLog(db, id, `remote transport failed: ${e.message}; running locally`) }
        if (r && r.accepted) { db.prepare('UPDATE offload_job SET node = ? WHERE id = ?').run(String(r.node ?? target), id); return { id, node: r.node ?? target, status: 'queued' } }
    }
    if (target !== 'planet') appendLog(db, id, `no ${target} transport registered yet; running on this machine`)
    if (spawnChild) {
        const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'nightly')
        const c = spawn(bin, ['offload', 'run', String(id)], { detached: true, stdio: 'ignore', env: process.env })
        c.unref()
    }
    return { id, node: 'local', status: 'queued' }
}

function appendLog(db, id, text) {
    const cur = db.prepare('SELECT log FROM offload_job WHERE id = ?').get(id)?.log ?? ''
    db.prepare('UPDATE offload_job SET log = ? WHERE id = ?').run((cur + text + '\n').slice(-LOG_MAX), id)
}

/** Execute one local job to the end (the detached child). `exec(cmd, args, opts)` is injectable for tests. */
export function execJob(db, id, { exec = spawnSync, projectRepo } = {}) {
    ensure(db)
    const job = db.prepare('SELECT * FROM offload_job WHERE id = ?').get(id)
    if (!job) throw new Error(`no offload job ${id}`)
    if (job.status !== 'queued') return job
    db.prepare("UPDATE offload_job SET status = 'running', started_at = ?, pid = ? WHERE id = ?").run(Date.now(), process.pid, id)
    const fail = (status, msg) => { appendLog(db, id, msg); db.prepare('UPDATE offload_job SET status = ?, finished_at = ?, result = ? WHERE id = ?').run(status, Date.now(), JSON.stringify({ error: msg }), id) }
    try {
        const repo = projectRepo ? projectRepo(job.project) : ''
        if (!repo) return fail('error', `project "${job.project}" has no repo path`) ?? get(db, id)
        const p = JSON.parse(job.params || '{}')
        const script = path.isAbsolute(p.script ?? '') ? p.script : path.join(repo, 'tools', 'playtest.sh')
        if (!existsSync(script)) return fail('error', `${script} not found (the per-game contract: tools/playtest.sh [--map M] [--bots N] [--duration S] printing a SOAK {json} line)`) ?? get(db, id)
        const args = playtestArgs(p)
        appendLog(db, id, `$ ${script} ${args.join(' ')}`)
        const r = exec(script, args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 << 20, timeout: (Number(p.duration ?? 120) + 600) * 1000 })
        return finishJob(db, id, `${r.stdout ?? ''}\n${r.stderr ?? ''}`, r.status)
    } catch (e) { fail('error', String(e.message ?? e)) }
    return get(db, id)
}

/** A job moved on outside this process (a node took it): status running|error, the node's name, a log line. */
export function markJob(db, id, { status = 'running', node = '', message = '' } = {}) {
    ensure(db)
    const job = get(db, id)
    if (!job) throw new Error(`no offload job ${id}`)
    if (!['queued', 'running'].includes(job.status)) return job
    if (!['running', 'error'].includes(status)) throw new Error('mark: running or error')
    if (message) appendLog(db, id, message)
    if (status === 'running') db.prepare("UPDATE offload_job SET status = 'running', started_at = coalesce(started_at, ?), node = coalesce(nullif(?, ''), node) WHERE id = ?").run(Date.now(), String(node), id)
    else db.prepare("UPDATE offload_job SET status = 'error', finished_at = ?, result = ? WHERE id = ?").run(Date.now(), JSON.stringify({ error: message || 'error' }), id)
    return get(db, id)
}

/** Close a job from its script output: parse the SOAK line, record the bot playtest, ok only on exit 0 and a pass. */
export function finishJob(db, id, text, code) {
    ensure(db)
    const job = get(db, id)
    if (!job) throw new Error(`no offload job ${id}`)
    if (!['queued', 'running'].includes(job.status)) return job
    const p = JSON.parse(job.params || '{}')
    appendLog(db, id, String(text ?? '').slice(-60_000))
    const facts = PB.parseSoak(String(text ?? ''))
    const rec = PB.record(db, { game: job.project, build: '', ...facts, mode: p.mode || 'offload', source: 'offload' })
    const exit = code === null || code === undefined || code === '' ? null : Number(code)
    db.prepare('UPDATE offload_job SET status = ?, finished_at = ?, result = ? WHERE id = ?')
        .run(exit === 0 && facts.result === 'pass' ? 'ok' : 'failed', Date.now(), JSON.stringify({ ...facts, playtestId: rec?.id ?? null, exit }), id)
    return get(db, id)
}

const get = (db, id) => db.prepare('SELECT * FROM offload_job WHERE id = ?').get(id)
export const jobGet = get
export function jobList(db, { kind, project, limit = 50 } = {}) {
    ensure(db)
    const w = [], a = []
    if (kind) { w.push('kind = ?'); a.push(kind) }
    if (project) { w.push('project = ?'); a.push(project) }
    return db.prepare(`SELECT * FROM offload_job ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).all(...a, limit)
}
/** Jobs stuck "running" whose process is gone (panel restart, kill) are closed as error. A job a node runs has no
 *  local process; it is closed only when it ran far past its duration (the node or the panel lost it). */
export function reapJobs(db, alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }, now = Date.now()) {
    ensure(db)
    let n = 0
    for (const j of db.prepare("SELECT id, pid, node, params, started_at FROM offload_job WHERE status = 'running'").all()) {
        if (j.node !== 'local') {
            const dur = Number(JSON.parse(j.params || '{}').duration ?? 120)
            if (now - Number(j.started_at ?? now) < (dur + 3600) * 1000) continue
        } else if (j.pid && alive(j.pid)) continue
        appendLog(db, j.id, 'process vanished; marked error'); db.prepare("UPDATE offload_job SET status = 'error', finished_at = ? WHERE id = ?").run(Date.now(), j.id); n++
    }
    return n
}
