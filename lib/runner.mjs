// Starting runs: the scheduler half of the CLI. Something calls `bin/nightly tick` once a
// minute -- the panel itself (src/instrumentation.ts), or a crontab line, or both: a schedule's
// minute is claimed atomically, so two tickers never fire it twice. Everything about when
// and what lives in the Schedule table and is edited in the panel.
//
//   tick         every minute: fire each enabled schedule whose cron matches this minute
//   start <id>   fire one schedule now (the panel's "Run now", or by hand)
//   exec <run>   internal: runs the runner script for an existing Run row, streams its
//                output into Run.log, records its pid, closes the run when it exits
//
// The runner script is the `run.sh` prompt (kind script) in the database, written to a
// private temp file for each run; a path in the `runner` setting or env NIGHTLY_RUNNER is
// used instead when set. It gets the run and schedule through the environment:
// NIGHTLY_RUN_ID, NIGHTLY_SCHEDULE_ID, NIGHTLY_SCHEDULE_NAME, NIGHTLY_PROMPT,
// NIGHTLY_INSTRUCTIONS, NIGHTLY_MAX_TURNS. A line `::nightly-meta {"turns":..,"minutes":..,"costUsd":..}`
// in its output fills those columns.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cronMatches } from './cron.mjs'
import * as P from './prompts.mjs'
import * as S from './store.mjs'

export const MAX_LOG = 400 * 1024
const META = '::nightly-meta '

/** { file, label, cleanup } for the runner, or { error }. */
function resolveRunner(db, id) {
    const override = process.env.NIGHTLY_RUNNER || S.getSetting(db, 'runner')
    if (override) {
        const file = path.resolve(S.ROOT, override)
        return existsSync(file) ? { file, label: file, cleanup: () => {} } : { error: `runner not found: ${file} (the "runner" setting or NIGHTLY_RUNNER)` }
    }
    const script = P.get(db, P.RUNNER_SCRIPT)
    if (!script?.body.trim()) return { error: `no runner: add a script prompt named ${P.RUNNER_SCRIPT} (Prompts in the panel) or set "runner" to a path` }
    const dir = mkdtempSync(path.join(os.tmpdir(), `nightly-run-${id}-`))
    const file = path.join(dir, P.RUNNER_SCRIPT)
    writeFileSync(file, script.body, { mode: 0o700 })
    return { file, label: `${P.RUNNER_SCRIPT} from the database`, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

export function pidAlive(pid) {
    if (!pid) return false
    try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

/** Runs still marked running whose process is alive. A row without a pid counts as live for
 *  its first 10 minutes (exec has not reported in yet), dead after. */
export function liveRuns(db) {
    return db.prepare("SELECT * FROM Run WHERE status = 'running'").all().filter((r) =>
        r.pid ? pidAlive(r.pid) : Date.now() - Date.parse(r.startedAt) < 10 * 60_000)
}

export const schedules = (db) => db.prepare('SELECT * FROM Schedule ORDER BY id').all()

/** Create the Run row for `schedule` and launch `nightly exec` on it, detached. Returns
 *  { id, status } -- status 'skipped' (with the row closed) when another run is live and
 *  the schedule does not allow overlap. */
export function fire(db, schedule, trigger, t = S.now()) {
    const busy = schedule.allowOverlap ? [] : liveRuns(db)
    const id = S.tx(db, () => {
        db.prepare('UPDATE Schedule SET lastFiredAt = ? WHERE id = ?').run(t, schedule.id)
        if (busy.length) {
            const why = `Skipped: run${busy.length > 1 ? 's' : ''} ${busy.map((r) => `#${r.id}`).join(', ')} still going and "${schedule.name}" does not allow overlap.`
            return Number(db.prepare(`INSERT INTO Run (startedAt, finishedAt, status, summary, report, log, minutes, trigger, scheduleId)
                VALUES (?, ?, 'skipped', ?, '', '', 0, ?, ?)`).run(t, t, why, trigger, schedule.id).lastInsertRowid)
        }
        return Number(db.prepare(`INSERT INTO Run (startedAt, status, summary, report, log, trigger, scheduleId)
            VALUES (?, 'running', '', '', '', ?, ?)`).run(t, trigger, schedule.id).lastInsertRowid)
    })
    if (busy.length) return { id, status: 'skipped' }
    const child = spawn(process.execPath, ['--no-warnings', path.join(S.ROOT, 'bin', 'nightly.mjs'), 'exec', String(id)], {
        detached: true, stdio: 'ignore', env: process.env,
    })
    child.unref()
    return { id, status: 'running' }
}

/** One cron minute. Returns what it did, one line per schedule fired. `source` names the
 *  ticker (NIGHTLY_TICK_SOURCE: panel | cron) for the "scheduler alive" line in the panel. */
export function tick(db, at = new Date(), { dryRun = false, source = process.env.NIGHTLY_TICK_SOURCE || 'cron' } = {}) {
    const lines = []
    const minute = new Date(at)
    minute.setSeconds(0, 0)
    const doRun = S.getSetting(db, 'doRun') === 'true'
    if (!dryRun) {
        S.setSetting(db, 'lastTickAt', at.toISOString())
        S.setSetting(db, 'lastTickBy', source)
    }
    // Claim this minute for a schedule: true for exactly one ticker, however many run.
    const claim = (s) => Number(db.prepare('UPDATE Schedule SET lastFiredAt = ? WHERE id = ? AND (lastFiredAt IS NULL OR lastFiredAt < ?)')
        .run(at.toISOString(), s.id, minute.toISOString()).changes) === 1
    for (const s of schedules(db)) {
        if (!s.enabled) continue
        let match
        try { match = cronMatches(s.cron, at) } catch (e) { lines.push(`schedule ${s.id} "${s.name}": bad cron "${s.cron}": ${e.message}`); continue }
        if (!match) continue
        if (s.lastFiredAt && Date.parse(s.lastFiredAt) >= minute.getTime()) continue   // already fired this minute
        if (dryRun) { lines.push(doRun ? `would fire "${s.name}"` : `"${s.name}" due, doRun is off`); continue }
        if (!claim(s)) continue   // another ticker took it a moment ago
        if (!doRun) {
            lines.push(`${S.local(at.toISOString())} "${s.name}" due, not started: doRun is off`)
            continue
        }
        const r = fire(db, s, 'cron', at.toISOString())
        lines.push(`${S.local(at.toISOString())} "${s.name}" -> run #${r.id} ${r.status}`)
    }
    endQuietAgents(db)
    return lines
}

/** Agents silent for 6 h are ended and their claims released, so a crashed session cannot
 *  hold a repository forever. */
function endQuietAgents(db) {
    const cutoff = new Date(Date.now() - 6 * 3600_000).toISOString()
    const quiet = db.prepare('SELECT id FROM Agent WHERE endedAt IS NULL AND lastSeenAt < ?').all(cutoff)
    if (!quiet.length) return
    const t = S.now()
    S.tx(db, () => {
        for (const a of quiet) {
            db.prepare('UPDATE Claim SET releasedAt = ? WHERE agentId = ? AND releasedAt IS NULL').run(t, a.id)
            db.prepare('UPDATE Agent SET endedAt = ? WHERE id = ?').run(t, a.id)
        }
    })
}

const tail = (s) => (s.length > MAX_LOG ? '…(start of log cut)\n' + s.slice(-MAX_LOG) : s)

/** Strip what a Next.js dev server (the panel's "Run now") or npm would leak into the
 *  runner: NODE_ENV=development breaks `next build` in every repo the agent touches. */
function runnerEnv(extra) {
    const env = { ...process.env }
    for (const k of Object.keys(env)) {
        if (k === 'NODE_ENV' || k.startsWith('__NEXT') || k.startsWith('NEXT_') || k.startsWith('TURBOPACK') || k.startsWith('npm_')) delete env[k]
    }
    return { ...env, ...extra }
}

/** Run the runner for run `id` and wait for it. Resolves with its exit code. */
export function exec(db, id) {
    const run = db.prepare('SELECT * FROM Run WHERE id = ?').get(id)
    if (!run) throw new Error(`no run ${id}`)
    if (run.status !== 'running') throw new Error(`run ${id} is ${run.status}, not running`)
    const sched = run.scheduleId ? db.prepare('SELECT * FROM Schedule WHERE id = ?').get(run.scheduleId) : null
    const runner = resolveRunner(db, id)
    let log = ''
    let dirty = false
    const meta = {}
    const save = () => {
        if (!dirty) return
        dirty = false
        db.prepare('UPDATE Run SET log = ? WHERE id = ?').run(tail(log), id)
    }
    const append = (s) => { log += s; dirty = true }
    let timer = null
    const finish = (code, signal) => {
        if (timer) clearInterval(timer)
        runner.cleanup?.()
        append(`\n--- runner exited ${signal ? `on ${signal}` : `with ${code}`} at ${S.local(S.now())} ---\n`)
        save()
        const r = db.prepare('SELECT * FROM Run WHERE id = ?').get(id)
        const minutes = Math.round((Date.now() - Date.parse(r.startedAt)) / 60000)
        db.prepare(`UPDATE Run SET pid = NULL, turns = COALESCE(turns, ?), minutes = COALESCE(?, minutes, ?), costUsd = COALESCE(costUsd, ?) WHERE id = ?`)
            .run(meta.turns ?? null, meta.minutes ?? null, minutes, meta.costUsd ?? null, id)
        // The agent normally closes its own run (`nightly run finish`); one that died first is closed here.
        if (r.status === 'running') {
            db.prepare("UPDATE Run SET status = ?, finishedAt = ?, summary = CASE WHEN summary = '' THEN ? ELSE summary END WHERE id = ?")
                .run(code === 0 ? 'ok' : 'failed', S.now(), code === 0 ? '' : `Runner exited ${signal ?? code} before the run reported.`, id)
        }
    }
    if (runner.error) {
        append(runner.error + '\n')
        finish(127, null)
        return Promise.resolve(127)
    }
    append(`--- ${sched ? `schedule "${sched.name}"` : 'no schedule'} · run #${id} · ${run.trigger} · ${S.local(S.now())} · ${runner.label} ---\n`)
    const child = spawn(runner.file, [], {
        cwd: S.ROOT,
        detached: true,   // its own process group, so "Stop" can end claude and everything it started
        stdio: ['ignore', 'pipe', 'pipe'],
        env: runnerEnv({
            NIGHTLY_RUN_ID: String(id),
            NIGHTLY_ROOT: S.ROOT,
            NIGHTLY_SCHEDULE_ID: sched ? String(sched.id) : '',
            NIGHTLY_SCHEDULE_NAME: sched?.name ?? '',
            NIGHTLY_PROMPT: sched?.prompt ?? 'nightly.md',
            NIGHTLY_INSTRUCTIONS: sched?.instructions ?? '',
            NIGHTLY_MAX_TURNS: String(sched?.maxTurns ?? 400),
            NIGHTLY_TRIGGER: run.trigger,
        }),
    })
    db.prepare('UPDATE Run SET pid = ? WHERE id = ?').run(child.pid ?? null, id)
    let partial = ''
    const onData = (buf) => {
        const s = partial + buf.toString('utf8')
        const lines = s.split('\n')
        partial = lines.pop()
        for (const l of lines) {
            if (l.startsWith(META)) { try { Object.assign(meta, JSON.parse(l.slice(META.length))) } catch { /* not ours */ } continue }
            append(l + '\n')
        }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    timer = setInterval(save, 5000)
    return new Promise((resolve) => {
        child.on('error', (e) => { append(`could not start runner: ${e.message}\n`); finish(126, null); resolve(126) })
        child.on('close', (code, signal) => { if (partial) append(partial + '\n'); finish(code ?? 1, signal); resolve(code ?? 1) })
    })
}

/** Stop a running run: SIGTERM to the runner's process group, then mark it failed. */
export function stop(db, id) {
    const r = db.prepare('SELECT * FROM Run WHERE id = ?').get(id)
    if (!r) throw new Error(`no run ${id}`)
    if (r.status !== 'running') return false
    if (r.pid && pidAlive(r.pid)) {
        try { process.kill(-r.pid, 'SIGTERM') } catch { try { process.kill(r.pid, 'SIGTERM') } catch { /* gone */ } }
    }
    db.prepare("UPDATE Run SET status = 'failed', finishedAt = ?, summary = CASE WHEN summary = '' THEN 'Stopped from the panel.' ELSE summary END WHERE id = ?")
        .run(S.now(), id)
    return true
}
