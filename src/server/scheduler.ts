import { execFile } from 'node:child_process'
import path from 'node:path'

// The built-in scheduler: while the panel runs, `bin/nightly tick` runs at the top of every
// minute, so no crontab entry is needed. tick is a separate process on purpose -- it reads the
// database with node:sqlite, which must never be opened inside this process (see db.ts and
// CLAUDE.md) -- and it claims each schedule's minute atomically, so a crontab ticking as well
// is harmless. Runs it starts are detached: restarting the panel does not stop them.
const g = globalThis as unknown as { nightlyScheduler?: NodeJS.Timeout }

function tick() {
    const bin = path.join(/*turbopackIgnore: true*/ process.cwd(), 'bin', 'nightly')
    execFile(bin, ['tick'], { timeout: 50_000, env: { ...process.env, NIGHTLY_TICK_SOURCE: 'panel' } }, (err, stdout, stderr) => {
        if (stdout.trim()) console.log(`[scheduler] ${stdout.trim()}`)
        if (err) console.error(`[scheduler] tick failed: ${(stderr || err.message).trim()}`)
    })
}

export function startScheduler() {
    if (g.nightlyScheduler) return   // dev reloads re-run module code; one ticker per process
    const schedule = () => {
        // A couple of seconds past the minute, so the clock has clearly entered it.
        const wait = 60_000 - (Date.now() % 60_000) + 2_000
        g.nightlyScheduler = setTimeout(() => { tick(); schedule() }, wait)
    }
    schedule()
    console.log('[scheduler] built in: schedules are checked every minute while the panel runs (NIGHTLY_SCHEDULER=off to disable)')
}
