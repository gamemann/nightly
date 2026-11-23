// `nightly transcript ...`: list, show, start, send, stop, runs, agents, ingest (and the internal `exec` worker).
// The panel's transcriptsRouter shells out to these with --json; keep the JSON shapes stable.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { homeOf, readRange, roots } from './transcripts-files.mjs'
import { renderLine } from './transcripts-parse.mjs'
import * as T from './transcripts-store.mjs'
import * as R from './transcripts-run.mjs'

export const TRANSCRIPT_HELP = `  transcript list [--q S] [--limit N] [--all] [--as USER]   Claude Code conversations, newest first (--all adds subagent threads)
  transcript show <id|session> [--tail N] [--full] [--json]   print a conversation (default: the last 20 entries)
  transcript start --prompt P [--cwd DIR] [--model M] [--effort E] [--mode default|acceptEdits|plan|auto|bypass] [--resume ID] [--fork] [--as USER] [--wait] [--user-id N]
                                                start claude (subscription login, sudo -u USER when it is not you); --wait prints the answer
  transcript send <id|session> <text|-> [--wait]   continue a conversation: into its live run, else a new --resume run
  transcript stop <id|run> [--interrupt]        stop the run (or only interrupt the current turn)
  transcript runs [--all]                       claude processes started from here
  transcript agents [--json]                    subagent threads with their parent and tool/token totals
  transcript ingest [--dir D]                   refresh the index from the session files (read-only; tick does this too)`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s ?? '')
const meUser = () => os.userInfo().username

/** Wait until `fn()` returns truthy, up to ms. */
async function until(fn, ms, step = 200) {
    const end = Date.now() + ms
    for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step) }
}

/** Entries of a transcript as rendered objects, by byte range (newest `tail`, or all). */
export function entries(db, t, { tail = 20 } = {}) {
    const rows = db.prepare('SELECT * FROM (SELECT * FROM TranscriptMessage WHERE transcriptId=? AND meta=0 ORDER BY seq DESC LIMIT ?) ORDER BY seq').all(t.id, tail > 0 ? tail : 1_000_000)
    const out = []
    for (const r of rows) {
        const e = renderLine(readRange(t.filePath, r.byteStart, r.byteLen).toString('utf8'))
        if (e) out.push({ seq: r.seq, ...e })
    }
    return out
}

export function plain(e) {
    const who = e.role === 'assistant' ? 'claude' : e.kind === 'tool_result' ? 'tool' : 'you'
    const parts = e.blocks.map((b) => (b.type === 'text' ? b.text : b.type === 'thinking' ? `[thinking] ${clip(b.text, 200)}` : b.type === 'tool_use' ? `[${b.name}] ${clip(JSON.stringify(b.input), 200)}` : b.type === 'tool_result' ? `[result${b.isError ? ' error' : ''}] ${clip(b.text, 300)}` : '[image]'))
    return `${(e.ts || '').slice(11, 19)} ${who}: ${parts.join('\n    ')}`
}

function resolve(db, key, die) {
    if (/^run-\d+$/.test(String(key))) return { run: db.prepare('SELECT * FROM TranscriptRun WHERE id=?').get(Number(String(key).slice(4))) }
    const t = T.find(db, key)
    if (!t) die(`no transcript "${key}" (nightly transcript list)`)
    return { t }
}

const lastAssistantText = (db, t) => {
    const es = entries(db, t, { tail: 12 }).filter((e) => e.role === 'assistant')
    const tx = es.flatMap((e) => e.blocks).filter((b) => b.type === 'text')
    return tx.length ? tx[tx.length - 1].text : ''
}

function startOpts(opt, die) {
    const cwd = path.resolve(String(opt.cwd ?? process.cwd()))
    if (!existsSync(cwd)) die(`cwd ${cwd} does not exist`)
    return { osUser: String(opt.as ?? meUser()), cwd, model: opt.model, effort: opt.effort, permissionMode: opt.mode ?? 'default', resume: opt.resume, prompt: opt.prompt, userId: opt.userId ? Number(opt.userId) : null }
}

/** Start (or resume) a run and wait for its session id. Returns { run, transcript }. */
export async function startRun(db, root, o, { fork } = {}) {
    T.ensure(db)
    let doFork = !!fork
    if (o.resume) {
        const t = T.find(db, o.resume)
        const held = t && R.runFor(db, t)
        if (t) { o = { ...o, resume: t.sessionId, transcriptId: t.id }; doFork = doFork || R.shouldFork(t.filePath, { busy: !!held }) }
    }
    const run = R.launch(db, root, o, { fork: doFork })
    const r = await until(() => { const x = db.prepare('SELECT * FROM TranscriptRun WHERE id=?').get(run.id); return x.transcriptId || x.status === 'failed' ? x : null }, 30_000)
    if (!r || r.status === 'failed') {
        const err = (existsSync(path.join(run.dir, 'err.log')) ? readFileSync(path.join(run.dir, 'err.log'), 'utf8') : '').trim().split('\n').slice(-3).join(' ')
        throw new Error(`claude did not start${r?.error ? `: ${r.error}` : ''}${err ? ` (${clip(err, 300)})` : ''}`)
    }
    return { run: r, transcript: db.prepare('SELECT * FROM Transcript WHERE id=?').get(r.transcriptId) }
}

/** Queue text for a conversation: into its live run, else a new --resume run. */
export async function sendTo(db, root, t, text, o = {}) {
    const live = R.runFor(db, t)
    if (live) { R.postCommand(live.dir, { type: 'user', text }); return { run: live, transcript: t, resumed: false } }
    const base = { osUser: t.osUser, cwd: t.cwd || os.homedir(), resume: t.sessionId, prompt: text, ...o }
    const r = await startRun(db, root, base)
    return { ...r, resumed: true }
}

/** Wait for the next `result` in a run's output; returns it (or null on timeout). */
export async function waitResult(run, sinceOff = 0, ms = 600_000) {
    let off = sinceOff
    const file = path.join(run.dir, 'out.ndjson')
    return until(() => {
        const [lines, n] = R.tailLines(file, off)
        off = n
        for (const l of lines) { try { const o = JSON.parse(l); if (o.type === 'result') return o } catch { /* partial */ } }
        return null
    }, ms, 300)
}

export async function runTranscriptCommand({ db, pos, opt, out, die, root, idleMinutes }) {
    T.ensure(db)
    const sub = pos[0] ?? 'list'
    if (sub === 'ingest') {
        const r = T.ingestAll(db, opt.dir ? { dirs: [String(opt.dir)] } : {})
        return out(r, () => `${r.files} files, ${r.changed} changed, ${r.added} entries added, ${r.linked} subagents linked${r.unreadable ? `, ${r.unreadable} unreadable` : ''}`)
    }
    if (sub === 'refresh') {
        const t = T.find(db, pos[1])
        if (!t) die(`no transcript "${pos[1]}"`)
        const ids = [t.id, ...db.prepare("SELECT id FROM Transcript WHERE sessionId=? AND agentId<>''").all(t.sessionId).map((r) => r.id)]
        let added = 0
        for (const id of ids) added += T.refresh(db, id)?.added ?? 0
        T.linkParents(db)
        return out({ id: t.id, added }, () => `${t.id}: ${added} new entries`)
    }
    if (sub === 'exec') {
        const id = Number(pos[1])
        const code = await R.worker(db, root, id, { idleMinutes })
        process.exit(code === 0 ? 0 : 1)
    }
    if (sub === 'list') {
        T.ingestAll(db)
        const rows = T.list(db, { q: opt.q ? String(opt.q) : '', limit: Number(opt.limit ?? 30), main: !opt.all, osUser: opt.as ? String(opt.as) : '' })
        return out(rows, () => rows.map((r) => `${String(r.id).padStart(6)} ${(r.lastAt || '').slice(0, 16).replace('T', ' ')} ${r.status.padEnd(7)} ${String(r.messageCount).padStart(4)} msgs  ${r.agentId ? `[${r.agentType || 'agent'}] ` : ''}${clip(r.title || r.sessionId, 80)}  ${r.osUser}@${path.basename(r.cwd || '-')}`).join('\n') || '(no transcripts)')
    }
    if (sub === 'show') {
        const { t } = resolve(db, pos[1], die)
        T.refresh(db, t.id)
        const es = entries(db, t, { tail: opt.full ? 0 : Number(opt.tail ?? 20) })
        return out({ transcript: t, entries: es }, () => `${t.title || t.sessionId}  (${t.messageCount} entries, ${t.osUser}, ${t.cwd})\n` + es.map(plain).join('\n'))
    }
    if (sub === 'runs') {
        const rows = db.prepare(`SELECT * FROM TranscriptRun ${opt.all ? '' : "WHERE status IN ('starting','running','idle')"} ORDER BY id DESC LIMIT 50`).all()
        if (!opt.all) R.activeRuns(db)
        return out(rows, () => rows.map((r) => `run-${r.id}  ${r.status.padEnd(8)} ${r.osUser}  pid ${r.pid}  ${r.model || '-'}  ${r.permissionMode}  ${r.cwd}  session ${r.sessionId || '-'}`).join('\n') || '(no runs)')
    }
    if (sub === 'agents') {
        T.ingestAll(db)
        const rows = db.prepare(`SELECT id,parentId,sessionId,agentId,agentType,description,model,startedAt,lastAt,messageCount,toolCount,outTokens,inTokens,status FROM Transcript WHERE agentId<>'' ORDER BY lastAt DESC LIMIT ?`).all(Number(opt.limit ?? 50))
        return out(rows, () => rows.map((r) => `${String(r.id).padStart(6)} <- ${String(r.parentId ?? '-').padStart(6)}  ${r.agentType || 'agent'}  ${r.toolCount} tools  ${r.outTokens} out  ${clip(r.description, 60)}`).join('\n') || '(none)')
    }
    if (sub === 'start') {
        if (!opt.prompt && !opt.resume) die('--prompt is required (or --resume)')
        const o = startOpts(opt, die)
        if (o.prompt === '-') o.prompt = readFileSync(0, 'utf8')
        const { run, transcript } = await startRun(db, root, o, { fork: !!opt.fork })
        const res = opt.wait ? await waitResult(run) : null
        const text = opt.wait ? (T.refresh(db, transcript.id), lastAssistantText(db, T.find(db, transcript.id))) : ''
        const payload = { runId: run.id, transcriptId: transcript.id, sessionId: transcript.sessionId, status: res ? 'idle' : run.status, answer: text, result: res ? { subtype: res.subtype, isError: !!res.is_error, costUsd: res.total_cost_usd ?? null } : null }
        return out(payload, () => (opt.wait ? text : `started run-${run.id}, transcript ${transcript.id} (session ${transcript.sessionId})`))
    }
    if (sub === 'send') {
        const { t } = resolve(db, pos[1], die)
        const text = pos[2] === '-' ? readFileSync(0, 'utf8') : pos.slice(2).join(' ')
        if (!text.trim()) die('nothing to send')
        const before = (() => { const lr = R.runFor(db, t); try { return lr ? R.tailLines(path.join(lr.dir, 'out.ndjson'), 0)[1] : 0 } catch { return 0 } })()
        const r = await sendTo(db, root, t, text, { osUser: opt.as ? String(opt.as) : t.osUser, model: opt.model, effort: opt.effort, permissionMode: opt.mode ?? 'default', userId: opt.userId ? Number(opt.userId) : null })
        const res = opt.wait ? await waitResult(r.run, r.resumed ? 0 : before) : null
        const answer = opt.wait ? (T.refresh(db, r.transcript.id), lastAssistantText(db, T.find(db, r.transcript.id))) : ''
        return out({ runId: r.run.id, transcriptId: r.transcript.id, resumed: r.resumed, answer, done: !!res }, () => (opt.wait ? answer : `sent to run-${r.run.id}${r.resumed ? ' (new --resume run)' : ''}`))
    }
    if (sub === 'stop') {
        const k = resolve(db, pos[1], die)
        const run = k.run ?? R.runFor(db, k.t)
        if (!run || !R.ACTIVE.includes(run.status)) die('no live run to stop')
        R.postCommand(run.dir, { type: opt.interrupt ? 'interrupt' : 'stop' })
        return out({ runId: run.id, action: opt.interrupt ? 'interrupt' : 'stop' }, () => `${opt.interrupt ? 'interrupt' : 'stop'} sent to run-${run.id}`)
    }
    die(`unknown transcript command "${sub}"`)
}
export { homeOf, roots }
