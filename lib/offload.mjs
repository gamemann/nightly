// Offload seam: run work "somewhere" (a Planet or Station). The Nodes builder registers a remote transport with setOffloadRemote();
// without one (or for target 'planet'/'local') the job runs on this machine, detached, so it outlives the panel request.
//   runOffload({ kind: 'playtest', project, target, params, requestedBy }) -> { id, node, status }   one offload_job row, status queued|running|ok|failed|error
//   nightly offload run <id> is the detached child that executes a local job (lib/ops-cli.mjs).
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

export function runOffload(db, { kind, project, target = 'planet', params = {}, requestedBy = '', spawnChild = true } = {}) {
    if (!KINDS.includes(kind)) throw new Error(`unknown offload kind "${kind}" (${KINDS.join(', ')})`)
    if (!project) throw new Error('project required')
    if (!TARGETS.includes(target)) throw new Error(`target must be one of ${TARGETS.join(', ')}`)
    ensure(db)
    const p = cleanParams(params)
    const now = Date.now()
    const id = Number(db.prepare('INSERT INTO offload_job (kind, project, target, node, params, status, requested_by, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(kind, String(project), target, 'local', JSON.stringify(p), 'queued', String(requestedBy), now).lastInsertRowid)
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
        const args = [...(p.map ? ['--map', p.map] : []), '--bots', String(p.bots ?? 4), '--duration', String(p.duration ?? 120)]
        appendLog(db, id, `$ ${script} ${args.join(' ')}`)
        const r = exec(script, args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 << 20, timeout: (Number(p.duration ?? 120) + 600) * 1000 })
        const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
        appendLog(db, id, text.slice(-60_000))
        const facts = PB.parseSoak(text)
        const rec = PB.record(db, { game: job.project, build: '', ...facts, mode: p.mode || 'offload', source: 'offload' })
        db.prepare('UPDATE offload_job SET status = ?, finished_at = ?, result = ? WHERE id = ?')
            .run(r.status === 0 && facts.result === 'pass' ? 'ok' : 'failed', Date.now(), JSON.stringify({ ...facts, playtestId: rec?.id ?? null, exit: r.status }), id)
    } catch (e) { fail('error', String(e.message ?? e)) }
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
/** Jobs stuck "running" whose process is gone (panel restart, kill) are closed as error. */
export function reapJobs(db, alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }) {
    ensure(db)
    let n = 0
    for (const j of db.prepare("SELECT id, pid FROM offload_job WHERE status = 'running'").all()) {
        if (j.pid && alive(j.pid)) continue
        appendLog(db, j.id, 'process vanished; marked error'); db.prepare("UPDATE offload_job SET status = 'error', finished_at = ? WHERE id = ?").run(Date.now(), j.id); n++
    }
    return n
}
