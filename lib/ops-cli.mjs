// CLI of the ops pages: nightly gh|ci|check|offload ... (the panel shells out to these; one writer, one set of rules).
import { readFileSync } from 'node:fs'
import * as S from './store.mjs'
import * as PS from './perf-store.mjs'
import * as G from './gh.mjs'
import * as CI from './ci.mjs'
import * as CK from './checks.mjs'
import * as O from './offload.mjs'
import { ensure } from './ops-store.mjs'

export const OPS_COMMANDS = ['gh', 'ci', 'check', 'offload']
export const OPS_BOOL = ['noGh']
export const OPS_HELP = `  gh status | calls [--limit N] | sample                 GitHub API budget: remaining per bucket (core/search/graphql), reset times, the recorded calls; sample stores a point (tick does hourly)
  ci sync [--repo owner/name] [--force] | list [--repo R] [--status S] | rerun|cancel <owner/name> <run_id>   CI workflows/runs: Forgejo first, GitHub (rate-limited via the gh wrapper) otherwise; cached (setting ciTtlMin)
  check scripts | add|edit <name> [--script chk-x.sh] [--args A] [--interval MIN] [--disable] [--item KEY] [--note T] | rm <name> | run <name> | runs [name] | due <item-key>   scripts/chk-*.sh checks with schedule; due = run an item check now
  offload run <id> | list [--kind K] [--project P] | show <id> | start playtest --project P [--target planet|station] [--map M] [--bots N] [--duration S] [--by WHO] [--node NAME] | mark <id> running|error [--node N] [--message M] | finish <id> --code N (log on stdin)   offload seam (playtest); run is the detached child, --node/mark/finish are the panel's node scheduler`

function projectRepo(db, slug) {
    try { const p = db.prepare('SELECT repoPath FROM Project WHERE slug = ?').get(slug); if (p?.repoPath) return p.repoPath } catch { /* no Project table yet */ }
    try { return PS.getGame(db, slug)?.repoPath ?? '' } catch { return '' }
}

export async function runOpsCommand(cmd, { db, pos, opt, out, die }) {
    ensure(db)
    const sub = pos.shift() ?? (cmd === 'offload' ? 'list' : cmd === 'gh' ? 'status' : 'list')
    try {
        if (cmd === 'gh') {
            const gh = G.ghFor(db, S.getSetting)
            if (sub === 'sample') { const s = gh.sample() ?? {}; return out(s, () => Object.entries(s).map(([b, v]) => `${b.padEnd(8)} ${v.remaining}/${v.limit} resets ${new Date(v.reset).toISOString()}`).join('\n') || '(gh unavailable)') }
            if (sub === 'calls') { const rows = db.prepare('SELECT * FROM gh_call ORDER BY id DESC LIMIT ?').all(Number(opt.limit ?? 30)); return out(rows, () => rows.map((r) => `${new Date(r.ts).toISOString().slice(5, 19)} ${r.bucket.padEnd(7)} ${String(r.status).padStart(3)} ${String(r.ms).padStart(5)}ms ${r.limited ? 'LIMITED ' : ''}${r.skipped ? 'SKIPPED ' : ''}${r.caller.padEnd(16)} ${r.cmd}`).join('\n') || '(no calls)') }
            const s = gh.sample() ?? {}; const low = G.lowBuckets(s, gh.cfg.warnPct)
            return out({ state: s, low }, () => (Object.entries(s).map(([b, v]) => `${b.padEnd(8)} ${v.remaining}/${v.limit}`).join('\n') || '(gh unavailable)') + (low.length ? `\nLOW: ${low.map((b) => b.bucket).join(', ')}` : ''))
        }
        if (cmd === 'ci') {
            const gh = G.ghFor(db, S.getSetting)
            if (sub === 'sync') {
                const r = opt.repo ? [await CI.syncRepo(db, String(opt.repo), { gh, force: !!opt.force })] : await CI.syncAll(db, { gh, force: !!opt.force })
                return out(r, () => r.map((x) => `${x.repo.padEnd(34)} ${(x.source || '-').padEnd(8)} ${String(x.runs).padStart(3)} runs${x.cached ? ' (cached)' : ''}${x.error ? '  ' + x.error : ''}`).join('\n') || '(no repos)')
            }
            if (sub === 'list') { const rows = CI.list(db, { repo: opt.repo ? String(opt.repo) : undefined, status: opt.status ? String(opt.status) : undefined, limit: Number(opt.limit ?? 40) }); return out(rows, () => rows.map((r) => `${r.verdict.padEnd(10)} ${r.repo.padEnd(30)} ${r.workflow.padEnd(20)} ${r.branch.padEnd(12)} ${r.source}`).join('\n') || '(no runs; nightly ci sync)') }
            if (sub === 'rerun' || sub === 'cancel') { const [repo, id] = pos; if (!repo || !id) die(`ci ${sub} <owner/name> <run_id>`); const r = CI.act(gh, db, sub, repo, id); return out(r, () => `${sub} sent for ${repo} #${id}`) }
            return die('ci sync|list|rerun|cancel')
        }
        if (cmd === 'check') {
            if (sub === 'scripts' || sub === 'list') { const rows = CK.list(db); return out(rows, () => rows.map((c) => `${c.configured ? (c.enabled ? 'on ' : 'off') : '-  '} ${c.name.padEnd(20)} ${String(c.intervalMin || 'manual').padEnd(7)} ${c.last ? c.last.status.padEnd(10) : 'never'.padEnd(10)} ${c.description}`).join('\n')) }
            if (sub === 'add' || sub === 'edit') {
                const name = pos.shift() ?? die(`check ${sub} <name>`)
                const cur = CK.list(db).find((c) => c.name === name)
                if (sub === 'edit' && !cur?.configured) die(`no configured check "${name}"`)
                const r = CK.save(db, { name, script: opt.script ?? cur?.script, args: opt.args ?? cur?.args ?? '', intervalMin: opt.interval ?? cur?.intervalMin ?? 0, enabled: opt.disable ? false : (cur?.configured ? cur.enabled : true), itemKey: opt.item ?? cur?.itemKey ?? '', note: opt.note ?? cur?.note ?? '' })
                return out(r, () => `check ${name} saved`)
            }
            if (sub === 'rm') { const r = CK.remove(db, pos.shift() ?? die('check rm <name>')); return out(r, () => `check ${r.name} removed`) }
            if (sub === 'run') { const r = CK.runScript(db, pos.shift() ?? die('check run <name>')); return out(r, () => `${r.status} (exit ${r.exit_code}, ${r.flags} flags)\n${r.output}`) }
            if (sub === 'runs') { const rows = CK.runs(db, { name: pos.shift() }); return out(rows, () => rows.map((r) => `${String(r.id).padStart(5)} ${new Date(r.started_at).toISOString().slice(0, 16)} ${r.name.padEnd(18)} ${r.status.padEnd(10)} ${r.trigger.padEnd(9)} ${r.flags} flags`).join('\n') || '(no runs)') }
            if (sub === 'due') {
                const key = pos.shift() ?? die('check due <item-key>')
                const it = S.getByKey?.(db, key) ?? db.prepare('SELECT id, kind FROM Item WHERE key = ?').get(key)
                if (!it || it.kind !== 'check') die(`${key} is not a check item`)
                db.prepare('UPDATE Item SET lastRunAt = NULL, updatedAt = ? WHERE id = ?').run(S.now(), it.id)
                return out({ key }, () => `${key} is due now (next agent or tick picks it up)`)
            }
            return die('check scripts|add|edit|rm|run|runs|due')
        }
        if (cmd === 'offload') {
            if (sub === 'run') { const j = O.execJob(db, Number(pos.shift() ?? die('offload run <id>')), { projectRepo: (p) => projectRepo(db, p) }); return out(j, () => `job ${j.id} ${j.status}`) }
            if (sub === 'list') { const rows = O.jobList(db, { kind: opt.kind && String(opt.kind), project: opt.project && String(opt.project), limit: Number(opt.limit ?? 30) }); return out(rows, () => rows.map((j) => `${String(j.id).padStart(4)} ${j.status.padEnd(8)} ${j.kind.padEnd(9)} ${j.project.padEnd(12)} ${j.target.padEnd(8)} ${j.node}`).join('\n') || '(no jobs)') }
            if (sub === 'show') { const j = O.jobGet(db, Number(pos.shift() ?? die('offload show <id>'))); if (!j) die('no such job'); return out(j, () => `${j.status} ${j.kind} ${j.project} on ${j.node}\n${j.log}`) }
            if (sub === 'start') {
                const kind = pos.shift() ?? die('offload start playtest --project P')
                const r = O.runOffload(db, { kind, project: String(opt.project ?? die('--project required')), target: String(opt.target ?? 'planet'), requestedBy: String(opt.by ?? ''), params: { map: opt.map, bots: opt.bots, duration: opt.duration }, node: opt.node && opt.node !== true ? String(opt.node) : '' })
                return out(r, () => `job ${r.id} ${r.status} on ${r.node}`)
            }
            if (sub === 'mark') {
                const id = Number(pos.shift() ?? die('offload mark <id> running|error')), status = pos.shift() ?? die('offload mark <id> running|error')
                const j = O.markJob(db, id, { status, node: opt.node && opt.node !== true ? String(opt.node) : '', message: opt.message && opt.message !== true ? String(opt.message) : '' })
                return out(j, () => `job ${j.id} ${j.status} on ${j.node}`)
            }
            if (sub === 'finish') {
                const id = Number(pos.shift() ?? die('offload finish <id> --code N'))
                let text = ''
                if (!process.stdin.isTTY) { try { text = readFileSync(0, 'utf8') } catch { text = '' } }
                const j = O.finishJob(db, id, text, opt.code === undefined || opt.code === true ? null : opt.code)
                return out(j, () => `job ${j.id} ${j.status}`)
            }
            if (sub === 'reap') { const n = O.reapJobs(db); return out({ reaped: n }, () => `${n} stale job(s) closed`) }
            return die('offload run|list|show|start|mark|finish|reap')
        }
    } catch (e) { return die(e.message) }
}

/** Tick: hourly GitHub budget sample, scheduled script checks, stale offload jobs, CI cache refresh (every ciTtlMin through the ttl, Forgejo first). */
export async function tickHook(db) {
    ensure(db)
    const lines = []
    const gh = G.ghFor(db, S.getSetting)
    const last = db.prepare("SELECT max(ts) t FROM gh_rate").get().t ?? 0
    if (Date.now() - last > 60 * 60_000) { const s = gh.sample() ?? {}; const low = G.lowBuckets(s, gh.cfg.warnPct); if (low.length) lines.push(`gh: low ${low.map((b) => `${b.bucket} ${b.remaining}/${b.limit}`).join(', ')}`) }
    lines.push(...CK.tickHook(db))
    const n = O.reapJobs(db); if (n) lines.push(`offload: ${n} stale job(s) closed`)
    if (S.getSetting(db, 'ciAutoSync') === 'true') { const r = await CI.syncAll(db, { gh }); const fresh = r.filter((x) => !x.cached); if (fresh.length) lines.push(`ci: refreshed ${fresh.length} repo(s)`) }
    return lines
}
