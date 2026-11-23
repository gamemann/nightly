// Running `claude` for a transcript. Panel and CLI both go through here (the panel shells out to `nightly transcript ...`).
// Subscription login only: ANTHROPIC_* variables are removed from the child's environment, so it can never bill an API key.
// One detached worker per run (`nightly transcript exec <runId>`) owns the claude process, so a run survives a panel restart:
//   <dir>/cmd.ndjson   inbox (append-only): {type:'user',text} | {type:'interrupt'} | {type:'stop'}   written by send/stop
//   <dir>/out.ndjson   everything claude prints (stream-json), one object per line                    read by the SSE route
//   <dir>/err.log      claude's stderr
// The session file itself is written by claude; nothing here ever writes to it.
import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { encodeCwd, homeOf, USER_RE } from './transcripts-files.mjs'
import { refresh, ingestFile, uidOf, localNodeId } from './transcripts-store.mjs'

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
export const MODES = { default: 'default', acceptEdits: 'acceptEdits', plan: 'plan', auto: 'auto', bypass: 'bypassPermissions' }
export const MODELS = ['opus', 'sonnet', 'haiku']
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,63}$/
/** A VS Code window may be live in a session file touched this recently: resume then forks instead of appending. */
export const FORK_WINDOW_MS = 90_000
export const ACTIVE = ['starting', 'running', 'idle']
const nowIso = () => new Date().toISOString()

/** Environment for the child: the parent's minus every ANTHROPIC_* and CLAUDE_CODE_OAUTH variable (login only, never keys). */
export function cleanEnv(env = process.env) {
    const out = {}
    for (const [k, v] of Object.entries(env)) if (v !== undefined && !/^ANTHROPIC_/.test(k) && k !== 'CLAUDE_CODE_OAUTH_TOKEN') out[k] = v
    return out
}

/** Validate and normalise start options; throws a readable Error for anything unsafe. */
export function checkOpts(o) {
    const osUser = String(o.osUser ?? '')
    if (!USER_RE.test(osUser) || osUser === 'root') throw new Error(`refusing to run as "${osUser}"`)
    const cwd = String(o.cwd ?? '')
    if (!path.isAbsolute(cwd) || cwd.includes('\0')) throw new Error('cwd must be an absolute path')
    const mode = MODES[o.permissionMode ?? 'default']
    if (!mode) throw new Error(`permission mode must be one of ${Object.keys(MODES).join(', ')}`)
    if (o.effort && !EFFORTS.includes(o.effort)) throw new Error(`effort must be one of ${EFFORTS.join(', ')}`)
    if (o.model && !MODEL_RE.test(o.model)) throw new Error('bad model name')
    if (o.resume && !/^[A-Za-z0-9-]{8,64}$/.test(o.resume)) throw new Error('bad session id')
    return { osUser, cwd, mode, effort: o.effort || '', model: o.model || '', resume: o.resume || '', addDirs: (o.addDirs ?? []).filter((d) => path.isAbsolute(d)) }
}

/** claude argv (no binary). fork: add --fork-session so a resumed session never appends to a file another window may hold. */
export function buildArgs(o, { fork = false } = {}) {
    const c = checkOpts(o)
    const a = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', c.mode]
    if (c.model) a.push('--model', c.model)
    if (c.effort) a.push('--effort', c.effort)
    if (c.resume) { a.push('--resume', c.resume); if (fork) a.push('--fork-session') }
    for (const d of c.addDirs) a.push('--add-dir', d)
    return a
}

/** Does resuming `file` risk colliding with a live writer? True when it changed within FORK_WINDOW_MS or a panel run holds it. */
export function shouldFork(file, { now = Date.now(), busy = false } = {}) {
    if (busy) return true
    try { return now - statSync(file).mtimeMs < FORK_WINDOW_MS } catch { return false }
}

/** The claude binary for a user: ~/.local/bin/claude when present, else whatever PATH offers. */
export function claudeBin(osUser) {
    const h = homeOf(osUser)
    const p = h && path.join(h, '.local', 'bin', 'claude')
    return p && existsSync(p) ? p : 'claude'
}

/** [command, args] to run claude as osUser: direct when it is the current OS user, else `sudo -n -H -u` with the key vars unset. */
export function spawnPlan(osUser, args, me = os.userInfo().username) {
    const bin = claudeBin(osUser)
    if (osUser === me) return [bin, args]
    return ['sudo', ['-n', '-H', '-u', osUser, 'env', '-u', 'ANTHROPIC_API_KEY', '-u', 'ANTHROPIC_AUTH_TOKEN', '-u', 'CLAUDE_CODE_OAUTH_TOKEN', bin, ...args]]
}

export const runDirOf = (root, id) => path.join(root, 'data', 'transcripts', `run-${id}`)
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

/** Runs that are still going; rows whose worker died are closed as failed. */
export function activeRuns(db) {
    const rows = db.prepare(`SELECT * FROM TranscriptRun WHERE status IN ('starting','running','idle') ORDER BY id`).all()
    return rows.filter((r) => {
        if (alive(r.pid) || (r.status === 'starting' && Date.now() - Date.parse(r.startedAt) < 15_000)) return true
        db.prepare("UPDATE TranscriptRun SET status='failed', error=CASE WHEN error='' THEN 'worker gone' ELSE error END, endedAt=? WHERE id=?").run(nowIso(), r.id)
        if (r.transcriptId) db.prepare("UPDATE Transcript SET status='idle' WHERE id=?").run(r.transcriptId)
        return false
    })
}

export const runFor = (db, t) => activeRuns(db).find((r) => (t.id && r.transcriptId === t.id) || (t.sessionId && r.sessionId === t.sessionId))

const post = (dir, cmd) => appendFileSync(path.join(dir, 'cmd.ndjson'), JSON.stringify(cmd) + '\n')

/** Create a run row, its directory and the detached worker. Returns the run row (status starting). */
export function launch(db, root, o, { now = nowIso(), fork = false } = {}) {
    const c = checkOpts(o)
    const args = buildArgs(o, { fork })
    const ins = db.prepare(`INSERT INTO TranscriptRun (transcriptId,sessionId,userId,osUser,nodeId,status,model,effort,permissionMode,cwd,resumeOf,startedAt)
      VALUES (?,?,?,?,?,'starting',?,?,?,?,?,?)`).run(o.transcriptId ?? null, o.resume || '', o.userId ?? null, c.osUser, localNodeId(db), c.model, c.effort, o.permissionMode ?? 'default', c.cwd, c.resume, now)
    const id = Number(ins.lastInsertRowid)
    const dir = runDirOf(root, id)
    mkdirSync(dir, { recursive: true, mode: 0o770 })
    writeFileSync(path.join(dir, 'args.json'), JSON.stringify(args))
    db.prepare('UPDATE TranscriptRun SET dir=? WHERE id=?').run(dir, id)
    if (o.prompt) post(dir, { type: 'user', text: String(o.prompt) })
    const child = spawn(process.execPath, ['--no-warnings', path.join(root, 'bin', 'nightly.mjs'), 'transcript', 'exec', String(id)], { detached: true, stdio: 'ignore', cwd: root, env: process.env })
    child.unref()
    db.prepare('UPDATE TranscriptRun SET pid=? WHERE id=?').run(child.pid ?? 0, id)
    return db.prepare('SELECT * FROM TranscriptRun WHERE id=?').get(id)
}

/** Read new complete lines of a file from an offset: [lines, newOffset]. */
export function tailLines(file, from) {
    let size
    try { size = statSync(file).size } catch { return [[], from] }
    if (size <= from) return [[], from]
    const buf = Buffer.alloc(size - from)
    const fd = openSync(file, 'r')
    try { readSync(fd, buf, 0, buf.length, from) } finally { closeSync(fd) }
    const end = buf.lastIndexOf(10)
    if (end < 0) return [[], from]
    return [buf.subarray(0, end).toString('utf8').split('\n').filter(Boolean), from + end + 1]
}

/**
 * The worker: spawns claude for run `id`, feeds it the inbox, mirrors stdout/stderr to the run dir, keeps the run row
 * current, ingests the transcript after each turn. Resolves with the exit code when claude is gone.
 */
export function worker(db, root, id, { idleMinutes = 30 } = {}) {
    const run = db.prepare('SELECT * FROM TranscriptRun WHERE id=?').get(id)
    if (!run) throw new Error(`no run ${id}`)
    const dir = run.dir
    const args = JSON.parse(readFileSync(path.join(dir, 'args.json'), 'utf8'))
    const [cmd, argv] = spawnPlan(run.osUser, args)
    const out = openSync(path.join(dir, 'out.ndjson'), 'a'), err = openSync(path.join(dir, 'err.log'), 'a')
    const set = (sql, ...a) => db.prepare(sql).run(...a)
    set("UPDATE TranscriptRun SET pid=?, status='starting' WHERE id=?", process.pid, id)
    return new Promise((resolve) => {
        const child = spawn(cmd, argv, { cwd: run.cwd, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
        let buf = '', inOff = 0, lastActive = Date.now(), done = false, tid = run.transcriptId, session = run.sessionId, turn = 0
        const finish = (code, why = '') => {
            if (done) return
            done = true
            clearInterval(timer)
            set("UPDATE TranscriptRun SET status=?, exitCode=?, error=CASE WHEN ?<>'' THEN ? ELSE error END, endedAt=? WHERE id=?", code === 0 ? 'ended' : 'failed', code, why, why, nowIso(), id)
            if (tid) { set("UPDATE Transcript SET status='idle' WHERE id=?", tid); try { refresh(db, tid) } catch { /* next ingest catches up */ } }
            resolve(code)
        }
        const onLine = (l) => {
            appendFileSync(out, l + '\n')
            let o
            try { o = JSON.parse(l) } catch { return }
            if (o.type === 'system' && o.subtype === 'init' && o.session_id) {
                session = o.session_id
                const file = path.join(homeOf(run.osUser) || os.homedir(), '.claude', 'projects', encodeCwd(o.cwd || run.cwd), `${session}.jsonl`)
                const uid = uidOf(run.osUser, session, '')
                let t = db.prepare('SELECT id FROM Transcript WHERE uid=?').get(uid)
                if (!t) {
                    const n = nowIso()
                    db.prepare(`INSERT OR IGNORE INTO Transcript (uid,nodeId,osUser,sessionId,filePath,cwd,model,source,status,forkedFrom,startedAt,lastAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,'panel','running',?,?,?,?,?)`)
                        .run(uid, run.nodeId, run.osUser, session, file, o.cwd || run.cwd, o.model || '', run.resumeOf && run.resumeOf !== session ? run.resumeOf : '', n, n, n, n)
                    t = db.prepare('SELECT id FROM Transcript WHERE uid=?').get(uid)
                }
                tid = t.id
                set("UPDATE Transcript SET source='panel', status='running' WHERE id=?", tid)
                set("UPDATE TranscriptRun SET sessionId=?, transcriptId=?, status='running' WHERE id=?", session, tid, id)
            } else if (o.type === 'result') {
                lastActive = Date.now(); turn++
                set("UPDATE TranscriptRun SET status='idle' WHERE id=?", id)
                if (tid) { set("UPDATE Transcript SET status='idle' WHERE id=?", tid); try { refresh(db, tid) } catch { /* ignore */ } }
            }
        }
        child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) onLine(l) } })
        child.stderr.on('data', (d) => appendFileSync(err, d))
        child.on('error', (e) => finish(127, `cannot start claude: ${e.message}`))
        child.on('exit', (code, sig) => finish(code ?? (sig ? 1 : 0), sig ? `killed by ${sig}` : ''))
        child.stdin.on('error', () => { /* claude already gone */ })
        const timer = setInterval(() => {
            const [lines, off] = tailLines(path.join(dir, 'cmd.ndjson'), inOff)
            inOff = off
            for (const l of lines) {
                let c
                try { c = JSON.parse(l) } catch { continue }
                lastActive = Date.now()
                if (c.type === 'user' && typeof c.text === 'string') {
                    set("UPDATE TranscriptRun SET status='running' WHERE id=?", id)
                    if (tid) set("UPDATE Transcript SET status='running' WHERE id=?", tid)
                    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: c.text } }) + '\n')
                } else if (c.type === 'interrupt') {
                    child.stdin.write(JSON.stringify({ type: 'control_request', request_id: `int-${Date.now()}`, request: { subtype: 'interrupt' } }) + '\n')
                } else if (c.type === 'stop') { child.kill('SIGTERM'); setTimeout(() => { if (!done) child.kill('SIGKILL') }, 5000) }
            }
            if (idleMinutes > 0 && Date.now() - lastActive > idleMinutes * 60_000) child.stdin.end()   // idle too long: let claude exit cleanly
        }, 250)
        void turn
    })
}

export { post as postCommand, ingestFile }
