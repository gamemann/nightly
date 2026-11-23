// Offload jobs on a node: run a command in a project workspace, stream its output, report the exit code.
// Restricted to the node's offload kinds and slots (build slots for normal jobs, heavy slots for heavy ones)
// and to workspace roots. Slots are counted here, not by scripts/heavy: the panel's scheduler reads them.
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

const MAX_LOG = 2 * 1024 * 1024
const err = (code, msg) => Object.assign(new Error(msg), { code })

export class JobRunner {
    /** cfg: loadConfig() result (read live); emit(ev, data) pushes events to the panel. */
    constructor(cfg, emit, { slots } = {}) {
        this.cfg = cfg; this.emit = emit; this.jobs = new Map(); this.slots = slots
        mkdirSync(path.join(cfg.state, 'jobs'), { recursive: true })
    }
    used(heavy) { return [...this.jobs.values()].filter((j) => j.status === 'running' && j.heavy === heavy).length }
    snapshot() { return [...this.jobs.values()].slice(-50).map(({ proc, ...j }) => j) }
    checkCwd(cwd) {
        let real
        try { real = realpathSync(cwd); if (!statSync(real).isDirectory()) throw new Error() } catch { throw err('bad-cwd', `cwd "${cwd}" is not a directory on this node`) }
        const ok = this.cfg.workspaces.some((w) => { try { const r = realpathSync(w); return real === r || real.startsWith(r + path.sep) } catch { return false } })
        if (!ok) throw err('cwd-not-allowed', `cwd "${cwd}" is outside the workspace roots (${this.cfg.workspaces.join(', ')})`)
        return real
    }
    start({ job, kind, cmd, cwd, env = {}, timeout = 0, heavy = false }) {
        if (!job || typeof job !== 'string') throw err('bad-job', 'job: an id string')
        if (this.jobs.get(job)?.status === 'running') throw err('duplicate', `job ${job} is already running`)
        if (!this.slots.kinds().includes(kind)) throw err('kind-not-supported', `this node does not offer "${kind}" (offers: ${this.slots.kinds().join(', ') || 'nothing'})`)
        if (typeof cmd !== 'string' || !cmd.trim()) throw err('bad-cmd', 'cmd: a shell command')
        const max = heavy ? this.slots.heavy() : this.slots.build()
        if (this.used(heavy) >= max) throw err('no-slot', `no free ${heavy ? 'heavy' : 'build'} slot (${this.used(heavy)}/${max})`)
        const real = this.checkCwd(cwd)
        const logFile = path.join(this.cfg.state, 'jobs', `${job.replace(/[^\w.-]/g, '_')}.log`)
        const j = { job, kind, cmd, cwd: real, heavy: !!heavy, status: 'running', startedAt: new Date().toISOString(), exitCode: null, logFile, bytes: 0 }
        const safeEnv = Object.fromEntries(Object.entries(env).filter(([k, v]) => /^[A-Z_][A-Z0-9_]*$/i.test(k) && typeof v === 'string'))
        const proc = spawn('bash', ['-c', cmd], { cwd: real, env: { ...process.env, ...safeEnv, NIGHTLY_JOB: job, NIGHTLY_JOB_KIND: kind }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
        j.proc = proc; this.jobs.set(job, j)
        let seq = 0
        const pipe = (stream) => (chunk) => {
            const text = chunk.toString('utf8')
            if (j.bytes < MAX_LOG) { appendFileSync(logFile, text); j.bytes += chunk.length }
            this.emit('log', { job, stream, seq: seq++, data: text })
        }
        proc.stdout.on('data', pipe('out')); proc.stderr.on('data', pipe('err'))
        let timedOut = false
        const timer = timeout > 0 ? setTimeout(() => { timedOut = true; this.kill(j, 'SIGTERM'); setTimeout(() => this.kill(j, 'SIGKILL'), 5000).unref() }, timeout * 1000) : null
        const finish = (code, signal, e) => {
            if (j.status !== 'running') return
            clearTimeout(timer)
            j.status = j.cancelled ? 'cancelled' : timedOut ? 'timeout' : code === 0 ? 'ok' : 'failed'
            j.exitCode = code ?? (signal ? 128 : 1); j.finishedAt = new Date().toISOString()
            this.emit('done', { job, status: j.status, code: j.exitCode, signal, error: e?.message, ms: Date.parse(j.finishedAt) - Date.parse(j.startedAt) })
        }
        proc.on('error', (e) => finish(127, null, e))
        proc.on('close', (code, signal) => finish(code, signal))
        return { job, status: 'running', logFile }
    }
    kill(j, sig) { try { process.kill(-j.proc.pid, sig) } catch { try { j.proc.kill(sig) } catch { /* gone */ } } }
    cancel(job) {
        const j = this.jobs.get(job)
        if (!j) throw err('no-job', `no job ${job}`)
        if (j.status !== 'running') return { job, status: j.status }
        j.cancelled = true; this.kill(j, 'SIGTERM'); setTimeout(() => this.kill(j, 'SIGKILL'), 5000).unref()
        return { job, status: 'cancelling' }
    }
    tail(job, bytes = 64 * 1024) {
        const j = this.jobs.get(job)
        if (!j) throw err('no-job', `no job ${job}`)
        let b
        try { b = readFileSync(j.logFile) } catch { return '' }
        return b.subarray(Math.max(0, b.length - bytes)).toString('utf8')
    }
    stopAll() { for (const j of this.jobs.values()) if (j.status === 'running') { j.cancelled = true; this.kill(j, 'SIGTERM') } }
}
