// CLI for the agent-board liveness commands: agent heartbeat | sweep | running.
import * as A from './agents.mjs'
import * as L from './agents-live.mjs'
import * as PS from './perf-store.mjs'

/** Returns true when it handled the subcommand. */
export function agentLive(sub, { db, pos, opt, out, die }) {
    if (sub === 'sweep') { const r = L.sweep(db); out({ swept: r }, () => (r.length ? `left: ${r.join(', ')}` : 'nobody to sweep')); return true }
    if (sub === 'running') {
        const r = L.unregistered(db)
        out(r, () => (!r.configured ? 'no source: set agentSourceCmd or agentSourceFile (nightly set)' : r.error ? `source failed: ${r.error}` : r.agents.map((a) => `${a.name}  ${a.task}`).join('\n') || '(everyone running is registered)'))
        return true
    }
    if (sub !== 'heartbeat') return false
    if (opt.requireToken || opt.tokenOnly) PS.authorizeIngest(db, process.env.NIGHTLY_PERF_TOKEN, '', { strict: !!opt.tokenOnly })
    const name = pos.shift() ?? die('agent heartbeat <name> [--task T] [--kind K] [--repos a,b] [--leave]')
    if (opt.leave) {
        const a = A.find(db, name)
        const rel = a ? A.leave(db, a, opt.note ? String(opt.note) : '') : []
        out({ left: !!a, released: rel }, () => (a ? 'left' : 'not on the board'))
        return true
    }
    const a = L.heartbeat(db, name, { kind: opt.kind ? String(opt.kind) : 'session', task: opt.task ? String(opt.task) : undefined, repos: opt.repos ? String(opt.repos) : undefined })
    out({ agent: a }, () => `${a.name} seen`)
    return true
}
