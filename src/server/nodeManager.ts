// The panel's side of the node links: one NodeManager (reconnecting WebSocket per node) for the whole process,
// kept in sync with the Node table, writing status and job results back, and dispatching queued NodeJob rows
// to the station the scheduler picks (kinds, slots, GPU only on GPU stations).
import { randomBytes } from 'node:crypto'
import { NodeManager, type NodeDesc, type NodeStatus } from '../../lib/node-client.mjs'
import { detectHeavy, inferKinds, pickNode, type SchedNode } from '../../lib/node-sched.mjs'
import { db } from './db'

type G = { nightlyNodes?: { mgr: NodeManager; timer?: ReturnType<typeof setInterval>; busy: boolean } }
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

export async function dispatchQueued() {
    const s = (g.nightlyNodes ??= { mgr: nodeMgr(), busy: false })
    if (s.busy) return
    s.busy = true
    try {
        for (const j of await db.nodeJob.findMany({ where: { status: 'queued' }, orderBy: { id: 'asc' }, take: 50 })) {
            const nodes = await schedList()
            const pick = pickNode(nodes, { kinds: [j.kind], heavy: j.heavy })
            if (!pick.node) {
                if (j.reason !== pick.why) await db.nodeJob.update({ where: { id: j.id }, data: { reason: pick.why } })
                continue
            }
            const project = j.projectId ? await db.project.findUnique({ where: { id: j.projectId } }) : null
            const cfg = j.buildId ? await db.buildConfig.findUnique({ where: { id: j.buildId } }) : null
            const cwd = project?.repoPath || process.cwd()
            try {
                await nodeMgr().request(pick.node.id, 'exec', { job: j.jobKey, kind: j.kind, cmd: j.command, cwd, heavy: j.heavy, timeout: cfg?.timeout ?? 0 })
                await db.nodeJob.update({ where: { id: j.id }, data: { status: 'running', nodeId: pick.node.id, startedAt: new Date(), reason: '' } })
            } catch (e) {
                const msg = (e as Error).message
                if (/no free|no-slot/.test(msg)) continue
                await db.nodeJob.update({ where: { id: j.id }, data: { status: 'failed', nodeId: pick.node.id, reason: msg, finishedAt: new Date() } })
            }
        }
    } finally { s.busy = false }
}

export async function cancelJob(id: number) {
    const j = await db.nodeJob.findUniqueOrThrow({ where: { id } })
    if (j.status === 'running' && j.nodeId) await nodeMgr().request(j.nodeId, 'cancel', { job: j.jobKey }).catch(() => {})
    await db.nodeJob.update({ where: { id }, data: { status: 'cancelled', finishedAt: new Date() } })
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
            void db.nodeJob.updateMany({ where: { jobKey: data.job }, data: { status, exitCode: data.code ?? null, finishedAt: new Date(), reason: data.error ?? '' } }).then(() => dispatchQueued()).catch(() => {})
        } else if (ev === 'ready' && data?.specs) {
            void db.node.update({ where: { id: desc.id }, data: { lastSeenAt: new Date() } }).catch(() => {})
        }
    })
    await syncNodes()
    s.timer = setInterval(() => void dispatchQueued().catch(() => {}), 5000)
    s.timer.unref?.()
}
