// The panel's side of the node links: one NodeManager (reconnecting WebSocket per node) for the whole process,
// kept in sync with the Node table, writing status and job results back, and dispatching queued NodeJob rows
// to the station the scheduler picks (kinds, slots, GPU only on GPU stations).
// Local fallback: a job no node can ever run (none offers its kind, or no nodes at all) runs on this machine in the
// project's repo, NIGHTLY_LOCAL_JOBS at a time (default 1, 0 = unlimited). A job that only waits for a busy node
// stays queued. Jobs named `offload:<id>` belong to an offload_job row (playtests); their start and end are
// reported to it through `nightly offload mark|finish`, so the CLI stays the one writer of that table.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { NodeManager, type NodeDesc, type NodeStatus } from '../../lib/node-client.mjs'
import { detectHeavy, inferKinds, nodeCwd, pickNode, type SchedNode } from '../../lib/node-sched.mjs'
import { db } from './db'

type G = { nightlyNodes?: { mgr: NodeManager; timer?: ReturnType<typeof setInterval>; busy: boolean }; nightlyLocalJobs?: Map<string, ChildProcess> }
const g = globalThis as unknown as G

const json = <T,>(s: string | null | undefined, d: T): T => { try { return s ? (JSON.parse(s) as T) : d } catch { return d } }
const LOG_KEEP = 20_000

export const nodeMgr = () => (g.nightlyNodes ??= { mgr: new NodeManager({ clientName: 'nightly-panel' }), busy: false }).mgr

/** Reload the node list from the DB and (re)connect. Call after any node create/edit/delete. */
export async function syncNodes() {
    const rows = await db.node.findMany()
    const descs: NodeDesc[] = rows.map((n) => ({ id: n.id, name: n.name, host: n.host, port: n.port, tls: n.tls, token: n.secret, enabled: !!n.host && !!n.secret, conn: json(n.conn, {}) }))
    nodeMgr().sync(descs)
}

async function schedList(): Promise<SchedNode[]> {
    const rows = await db.node.findMany()
    const st = new Map(nodeMgr().statuses().map((s: NodeStatus) => [s.id, s]))
    const running = await db.nodeJob.findMany({ where: { status: 'running', nodeId: { not: null } } })
    return rows.map((n) => {
        const s = st.get(n.id)
        const reserved = { build: 0, heavy: 0 }
        for (const j of running) if (j.nodeId === n.id) reserved[j.heavy ? 'heavy' : 'build']++
        return { id: n.id, name: n.name, type: n.type, online: s?.state === 'online', specs: json(n.specs, {}), live: s?.live ?? null, reserved }
    })
}

/** Queue a job; dispatch happens right away when a node is free, else on the next tick. */
export async function enqueueJob(o: { name: string; command: string; kind?: string; kinds?: string[]; heavy?: boolean; projectId?: number; buildId?: number }) {
    const heavy = detectHeavy(o.command, o.heavy).heavy
    const kind = o.kind ?? o.kinds?.[0] ?? inferKinds(o.command)[0] ?? 'build'
    const job = await db.nodeJob.create({ data: { jobKey: `j${Date.now().toString(36)}${randomBytes(3).toString('hex')}`, name: o.name, kind, command: o.command, heavy, projectId: o.projectId, buildId: o.buildId } })
    void dispatchQueued()
    return job
}

/** Can some node run these kinds, now or once a slot frees? (Planets count unless planetFallback is false.) */
export async function nodeFor(kinds: string[], o: { heavy?: boolean; planetFallback?: boolean } = {}) {
    const pick = pickNode(await schedList(), { kinds, heavy: o.heavy }, { planetFallback: o.planetFallback ?? true })
    return { node: pick.node?.name ?? null, capable: pick.capable.map((n) => n.name), why: pick.why }
}

const localJobs = () => (g.nightlyLocalJobs ??= new Map())
const localMax = () => { const n = Number(process.env.NIGHTLY_LOCAL_JOBS ?? 1); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1 }
const offloadId = (name: string) => { const m = /^offload:(\d+)$/.exec(name); return m ? m[1] : null }

/** Tell the offload_job row behind an `offload:<id>` job what happened (CLI is its one writer). */
function offloadCli(args: string[], input?: string) {
    try {
        const c = spawn(path.join(process.cwd(), 'bin', 'nightly'), ['offload', ...args], { stdio: [input === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'], env: process.env })
        c.on('error', () => {})
        if (input !== undefined) { c.stdin?.on('error', () => {}); c.stdin?.end(input) }
    } catch { /* the reaper closes the row later */ }
}

/** One place every job ends: NodeJob row, the offload row behind it, then the next dispatch. */
async function finished(jobKey: string, status: string, code: number | null, reason: string) {
    await db.nodeJob.updateMany({ where: { jobKey, status: { in: ['queued', 'running'] } }, data: { status, exitCode: code, finishedAt: new Date(), reason } })
    const j = await db.nodeJob.findUnique({ where: { jobKey } })
    const oid = j && offloadId(j.name)
    if (oid) {
        if (status === 'ok' || status === 'failed') offloadCli(['finish', oid, ...(code === null ? [] : ['--code', String(code)])], j.log)
        else offloadCli(['mark', oid, 'error', '--message', `${status}${reason ? `: ${reason}` : ''}`])
    }
    void dispatchQueued()
}

/** Run a job here: bash in the project's repo, log into the NodeJob row (throttled), timeout from its build config. */
function runLocal(j: { id: number; jobKey: string; command: string; name: string }, cwd: string, timeoutSec: number) {
    const child = spawn('bash', ['-c', j.command], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
    localJobs().set(j.jobKey, child)
    let log = `$ ${j.command}\n(running on the panel host: no node offers this kind)\n`, dirty = true
    const add = (b: Buffer) => { log = (log + b.toString()).slice(-LOG_KEEP); dirty = true }
    child.stdout?.on('data', add); child.stderr?.on('data', add)
    const flush = () => { if (!dirty) return; dirty = false; void db.nodeJob.update({ where: { id: j.id }, data: { log } }).catch(() => {}) }
    const tick = setInterval(flush, 2000); tick.unref?.()
    const kill = timeoutSec > 0 ? setTimeout(() => { add(Buffer.from(`\ntimed out after ${timeoutSec}s\n`)); child.kill('SIGTERM') }, timeoutSec * 1000) : null
    let done = false
    const end = (code: number | null, err = '') => {
        if (done) return
        done = true
        clearInterval(tick); if (kill) clearTimeout(kill)
        localJobs().delete(j.jobKey)
        dirty = true; flush()
        void finished(j.jobKey, code === 0 ? 'ok' : 'failed', code, err).catch(() => {})
    }
    child.on('error', (e) => end(null, e.message))
    child.on('close', (code) => end(code))
}

export async function dispatchQueued() {
    const s = (g.nightlyNodes ??= { mgr: nodeMgr(), busy: false })
    if (s.busy) return
    s.busy = true
    try {
        for (const j of await db.nodeJob.findMany({ where: { status: 'queued' }, orderBy: { id: 'asc' }, take: 50 })) {
            const nodes = await schedList()
            const pick = pickNode(nodes, { kinds: [j.kind], heavy: j.heavy })
            const project = j.projectId ? await db.project.findUnique({ where: { id: j.projectId } }) : null
            const cfg = j.buildId ? await db.buildConfig.findUnique({ where: { id: j.buildId } }) : null
            if (!pick.node) {
                const max = localMax()
                if (!pick.capable.length && (max === 0 || localJobs().size < max)) {
                    // No node will ever take it: run it here.
                    await db.nodeJob.update({ where: { id: j.id }, data: { status: 'running', nodeId: null, startedAt: new Date(), reason: `local: ${pick.why}` } })
                    const oid = offloadId(j.name)
                    if (oid) offloadCli(['mark', oid, 'running', '--node', 'local', '--message', `no node can run it (${pick.why}); running on the panel host`])
                    runLocal(j, project?.repoPath || process.cwd(), cfg?.timeout ?? 0)
                    continue
                }
                const why = pick.capable.length ? pick.why : `waiting for a local slot (${pick.why})`
                if (j.reason !== why) await db.nodeJob.update({ where: { id: j.id }, data: { reason: why } })
                continue
            }
            const cwd = nodeCwd(pick.node, project) || (pick.node.type === 'planet' ? process.cwd() : pick.node.specs?.workspace ?? '')
            if (!cwd) {
                await db.nodeJob.update({ where: { id: j.id }, data: { status: 'failed', nodeId: pick.node.id, reason: `no working directory on ${pick.node.name}: set its workspace or a project path`, finishedAt: new Date() } })
                await finished(j.jobKey, 'failed', null, `no working directory on ${pick.node.name}`)
                continue
            }
            try {
                await nodeMgr().request(pick.node.id, 'exec', { job: j.jobKey, kind: j.kind, cmd: j.command, cwd, heavy: j.heavy, timeout: cfg?.timeout ?? 0 })
                await db.nodeJob.update({ where: { id: j.id }, data: { status: 'running', nodeId: pick.node.id, startedAt: new Date(), reason: '' } })
                const oid = offloadId(j.name)
                if (oid) offloadCli(['mark', oid, 'running', '--node', pick.node.name])
            } catch (e) {
                const msg = (e as Error).message
                if (/no free|no-slot/.test(msg)) continue
                await db.nodeJob.update({ where: { id: j.id }, data: { status: 'failed', nodeId: pick.node.id, reason: msg, finishedAt: new Date() } })
                const oid = offloadId(j.name)
                if (oid) offloadCli(['mark', oid, 'error', '--message', `${pick.node.name}: ${msg}`])
            }
        }
    } finally { s.busy = false }
}

export async function cancelJob(id: number) {
    const j = await db.nodeJob.findUniqueOrThrow({ where: { id } })
    if (j.status === 'running' && j.nodeId) await nodeMgr().request(j.nodeId, 'cancel', { job: j.jobKey }).catch(() => {})
    if (j.status === 'running' && !j.nodeId) localJobs().get(j.jobKey)?.kill('SIGTERM')
    await finished(j.jobKey, 'cancelled', null, 'cancelled')
}

export async function startNodeManager() {
    const s = (g.nightlyNodes ??= { mgr: nodeMgr(), busy: false })
    if (s.timer) return
    const mgr = s.mgr
    mgr.on('status', (st: NodeStatus) => {
        const state = st.state === 'online' ? 'online' : st.state === 'denied' ? 'denied' : 'offline'
        void db.node.update({ where: { id: st.id }, data: { status: state, ...(st.state === 'online' ? { lastSeenAt: new Date() } : {}) } }).catch(() => {})
    })
    mgr.on('event', (ev: string, data: any, desc: NodeDesc) => {
        if (ev === 'log' && data?.job) {
            void db.nodeJob.findUnique({ where: { jobKey: data.job } }).then((j) => j && db.nodeJob.update({ where: { id: j.id }, data: { log: (j.log + String(data.data ?? '')).slice(-LOG_KEEP) } })).catch(() => {})
        } else if (ev === 'done' && data?.job) {
            const status = data.status === 'ok' || data.code === 0 ? 'ok' : data.status === 'cancelled' ? 'cancelled' : 'failed'
            void finished(String(data.job), status, typeof data.code === 'number' ? data.code : null, data.error ?? '').catch(() => {})
        } else if (ev === 'ready' && data?.specs) {
            void db.node.update({ where: { id: desc.id }, data: { lastSeenAt: new Date() } }).catch(() => {})
        }
    })
    await syncNodes()
    s.timer = setInterval(() => void dispatchQueued().catch(() => {}), 5000)
    s.timer.unref?.()
}
