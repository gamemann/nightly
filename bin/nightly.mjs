// nightly -- CLI over the nightly to-do database. See README.md for the reference.
import '../lib/env.mjs'   // first: the other modules read process.env when they load
import { readFileSync } from 'node:fs'
import * as A from '../lib/agents.mjs'
import { cronError, nextFires } from '../lib/cron.mjs'
import * as P from '../lib/prompts.mjs'
import * as R from '../lib/runner.mjs'
import * as S from '../lib/store.mjs'

const argv = process.argv.slice(2)
const BOOL = new Set(['json', 'all', 'top', 'due', 'help', 'h', 'dryRun', 'force', 'peek'])

function parse(args) {
    const pos = []
    const opt = {}
    for (let i = 0; i < args.length; i++) {
        const a = args[i]
        if (a === '--') { pos.push(...args.slice(i + 1)); break }
        if (a.startsWith('--')) {
            let [k, v] = a.slice(2).split(/=(.*)/s)
            k = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
            if (v === undefined) {
                if (BOOL.has(k)) v = true
                else if (i + 1 < args.length) v = args[++i]
                else die(`--${k} needs a value`)
            }
            opt[k] = v
        } else if (a === '-h') opt.help = true
        else pos.push(a)
    }
    return { pos, opt }
}

function die(msg, code = 1) {
    process.stderr.write(`nightly: ${msg}\n`)
    process.exit(code)
}

const readStdin = () => {
    if (process.stdin.isTTY) return ''
    try { return readFileSync(0, 'utf8') } catch { return '' }
}
const readText = (f) => (f === '-' ? readStdin() : readFileSync(f, 'utf8'))
const csv = (v) => (v === undefined || v === true ? undefined : String(v).split(',').map((s) => s.trim()).filter(Boolean))
const int = (v, what) => {
    const n = Number(v)
    if (!Number.isFinite(n)) die(`${what} must be a number`)
    return Math.trunc(n)
}
const day = (iso) => (iso ? S.local(iso).slice(0, 10) : '-')
const firstLines = (s, n) => (s ?? '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, n)
const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s ?? '')

const { pos, opt } = parse(argv)
const cmd = pos.shift()
const J = !!opt.json
const out = (obj, human) => process.stdout.write(J ? JSON.stringify(obj, null, 2) + '\n' : human() + '\n')
const line = (it) => `${it.key.padEnd(22)} ${it.status.padEnd(11)} ${it.kind.padEnd(6)} ${it.title}`

const HELP = `nightly -- the nightly run's to-do database (${S.DB_PATH})

  list [--status a,b] [--kind a,b] [--all]      open items (or --all), by status then priority
  show <key>                                    full body + notes
  add --title T [--key K] [--kind task|issue|check|study] [--body B | --body-file F | stdin]
      [--repos a,b] [--done-when ..] [--status S] [--cadence C]
      [--priority N | --top | --after KEY] [--by christian|nightly|session]
  set <key> [--status S] [--priority N | --top | --after KEY] [--title ..] [--body B | --body-file F]
      [--repos ..] [--done-when ..] [--kind ..] [--cadence ..]
  note <key> [--run ID] [--by nightly] <text | --file F | stdin>
  checks [--due]                                recurring checks (and which are due)
  checked <key> [--note ..] [--run ID]          stamp a check's lastRunAt
  run start | run finish <id> --status ok|failed|skipped --summary S [--report-file F] [--turns N] [--minutes N]
  run list | run show <id> | run stop <id>
  run close-stale --status ok|failed [--report-file F]   close runs still 'running' whose process is gone

  prompt list | show <name> | history <name>    the agent's prompts and the runner script (show prints the body)
  prompt set <name> [--file F | stdin] [--note N] [--by B] [--kind prompt|script]

  schedule list                                 when the runner starts (edit in the panel)
  tick [--dry-run]                              crontab, every minute: fire the schedules due now
  start <schedule-id|name>                      fire one schedule now (ignores doRun); prints the run id

  agent join <name> [--task T] [--repos a,b] [--kind session|nightly] [--run ID]
  agent claim <name> <path...> [--note N] [--force]   exit 3 if a live agent holds an overlapping path
  agent release <name> [<path...>]              (no path = all of them)
  agent say <name> [--to AGENT] <text | stdin>
  agent inbox <name> [--peek]                   messages for you since you last looked
  agent board                                   who is live, what they hold, recent messages
  agent leave <name> [--note N]                 releases everything
  get <setting>            (get doRun prints exactly true/false)
  set-setting <key> <value>
  brief                                         compact digest for the nightly prompt

  Every command takes --json.`

function cmdList() {
    const statuses = csv(opt.status) ?? (opt.all ? S.STATUSES : S.OPEN_STATUSES)
    // Standing checks live in `nightly checks`; list shows them only when asked for.
    const kinds = csv(opt.kind) ?? (opt.all ? undefined : S.KINDS.filter((k) => k !== 'check'))
    const q = `SELECT * FROM Item WHERE status IN (${statuses.map(() => '?').join(',')})` +
        (kinds ? ` AND kind IN (${kinds.map(() => '?').join(',')})` : '') +
        ' ORDER BY priority, id'
    const order = { in_progress: 0, review: 1, queue: 2, blocked: 3, done: 4, wontfix: 5 }
    const rows = db.prepare(q).all(...statuses, ...(kinds ?? []))
        .sort((a, b) => order[a.status] - order[b.status] || a.priority - b.priority ||
            (a.status === 'done' ? (b.completedAt ?? '').localeCompare(a.completedAt ?? '') : 0))
    out(rows, () => (rows.length ? rows.map(line).join('\n') : '(nothing)'))
}

function showItem(it, notes) {
    const h = [
        `[${it.key}] ${it.title}`,
        `status: ${it.status}   kind: ${it.kind}   priority: ${it.priority}   added: ${day(it.createdAt)} by ${it.addedBy}` +
            (it.completedAt ? `   completed: ${day(it.completedAt)}` : ''),
    ]
    if (it.repos) h.push(`repos: ${it.repos}`)
    if (it.doneWhen) h.push(`done when: ${it.doneWhen}`)
    if (it.cadence) h.push(`cadence: ${it.cadence}   last run: ${it.lastRunAt ?? 'never'}${S.isDue(it) ? '   (DUE)' : ''}`)
    h.push('', it.body || '(no body)')
    for (const n of notes) h.push('', `--- note ${S.local(n.createdAt)} by ${n.author}${n.runId ? ` (run ${n.runId})` : ''}`, n.body)
    return h.join('\n')
}

function cmdShow() {
    const key = pos[0] ?? die('show <key>')
    const it = S.mustItem(db, key)
    const notes = S.notesFor(db, it.id)
    out({ ...it, notes }, () => showItem(it, notes))
}

function where() {
    if (opt.top) return 'top'
    if (opt.after) return { after: String(opt.after) }
    if (opt.priority !== undefined) return int(opt.priority, '--priority')
    return undefined
}

function bodyOpt(allowStdin) {
    if (opt.body !== undefined) return String(opt.body)
    if (opt.bodyFile) return readText(String(opt.bodyFile))
    if (allowStdin) return readStdin()
    return undefined
}

function cmdAdd() {
    const title = opt.title ?? (pos.length ? pos.join(' ') : die('add --title T'))
    const it = S.addItem(db, {
        title: String(title),
        key: opt.key,
        kind: opt.kind,
        status: opt.status,
        body: bodyOpt(true),
        repos: csv(opt.repos)?.join(', '),
        doneWhen: opt.doneWhen,
        cadence: opt.cadence,
        addedBy: opt.by ?? 'nightly',
        where: where(),
    })
    out(it, () => `added ${it.key}  (${it.status}, priority ${it.priority})`)
}

function cmdSet() {
    const key = pos[0] ?? die('set <key> [--status S] ...')
    const it = S.updateItem(db, key, {
        status: opt.status,
        title: opt.title,
        body: bodyOpt(false),
        repos: opt.repos !== undefined ? csv(opt.repos).join(', ') : undefined,
        doneWhen: opt.doneWhen,
        kind: opt.kind,
        cadence: opt.cadence,
        priority: where(),
    })
    out(it, () => line(it) + `  (priority ${it.priority})`)
}

function cmdNote() {
    const key = pos.shift() ?? die('note <key> <text>')
    const body = opt.file ? readText(String(opt.file)) : pos.length ? pos.join(' ') : readStdin()
    if (!body.trim()) die('empty note')
    const n = S.addNote(db, key, body.trim(), { author: opt.by ?? 'nightly', runId: opt.run ? int(opt.run, '--run') : null })
    out(n, () => `noted on ${key} (#${n.id})`)
}

function cmdChecks() {
    let rows = S.checks(db).filter((c) => S.OPEN_STATUSES.includes(c.status))
    if (opt.due) rows = rows.filter((c) => S.isDue(c))
    rows = rows.map((c) => ({ ...c, due: S.isDue(c) }))
    out(rows, () =>
        rows.length
            ? rows.map((c) => `${c.due ? 'DUE ' : '    '}${c.key.padEnd(20)} ${(c.cadence ?? '').padEnd(12)} ${day(c.lastRunAt).padEnd(10)} ${c.title}`).join('\n')
            : '(no checks due)')
}

function cmdChecked() {
    const key = pos[0] ?? die('checked <key>')
    const it = S.mustItem(db, key)
    S.tx(db, () => db.prepare('UPDATE Item SET lastRunAt = ?, updatedAt = ? WHERE id = ?').run(S.now(), S.now(), it.id))
    if (opt.note) S.addNote(db, key, String(opt.note), { author: opt.by ?? 'nightly', runId: opt.run ? int(opt.run, '--run') : null })
    const after = S.mustItem(db, key)
    out(after, () => `checked ${key} at ${after.lastRunAt}`)
}

const MAX_REPORT = 200 * 1024
const readReport = (f) => {
    const s = readText(f)
    return s.length > MAX_REPORT ? s.slice(0, MAX_REPORT) + '\n\n…(truncated)' : s
}

function cmdRun() {
    const sub = pos.shift()
    if (sub === 'start') {
        // Under `nightly exec` the row already exists; the prompt's `run start` picks it up.
        const pre = Number(process.env.NIGHTLY_RUN_ID)
        if (pre && db.prepare("SELECT 1 FROM Run WHERE id = ? AND status = 'running'").get(pre)) return out({ id: pre }, () => String(pre))
        const r = db.prepare("INSERT INTO Run (startedAt, status, summary, report) VALUES (?, 'running', '', '')").run(S.now())
        const id = Number(r.lastInsertRowid)
        return out({ id }, () => String(id))
    }
    if (sub === 'finish') {
        const id = int(pos[0] ?? die('run finish <id> --status S'), 'id')
        const run = db.prepare('SELECT * FROM Run WHERE id = ?').get(id) ?? die(`no run ${id}`)
        const status = String(opt.status ?? 'ok')
        if (!S.RUN_STATUSES.includes(status)) die(`bad status ${status}`)
        db.prepare('UPDATE Run SET finishedAt = ?, status = ?, summary = ?, report = ?, turns = ?, minutes = ? WHERE id = ?').run(
            S.now(), status, opt.summary !== undefined ? String(opt.summary) : run.summary,
            opt.reportFile ? readReport(String(opt.reportFile)) : run.report,
            opt.turns !== undefined ? int(opt.turns, '--turns') : run.turns,
            opt.minutes !== undefined ? Number(opt.minutes) : run.minutes ?? Math.round((Date.now() - Date.parse(run.startedAt)) / 60000),
            id,
        )
        const r = db.prepare('SELECT id, startedAt, finishedAt, status, summary, turns, minutes FROM Run WHERE id = ?').get(id)
        return out(r, () => `run ${id} ${status}`)
    }
    if (sub === 'close-stale') {
        const status = String(opt.status ?? 'failed')
        if (!S.RUN_STATUSES.includes(status) || status === 'running') die(`bad status ${status}`)
        const report = opt.reportFile ? readReport(String(opt.reportFile)) : null
        // Read inside the write transaction, so a run started meanwhile is either closed or left alone, never half.
        const stale = S.tx(db, () => {
            const live = new Set(R.liveRuns(db).map((r) => r.id))
            const stale = db.prepare("SELECT * FROM Run WHERE status = 'running'").all().filter((r) => !live.has(r.id))
            for (const r of stale) {
                db.prepare('UPDATE Run SET finishedAt = ?, status = ?, report = ?, minutes = COALESCE(minutes, ?) WHERE id = ?').run(
                    S.now(), status, r.report ? r.report : report ?? '',
                    Math.round((Date.now() - Date.parse(r.startedAt)) / 60000), r.id)
            }
            return stale
        })
        return out({ closed: stale.length, ids: stale.map((r) => r.id) }, () => `closed ${stale.length}`)
    }
    if (sub === 'list') {
        const rows = db.prepare(`SELECT r.id, r.startedAt, r.finishedAt, r.status, r.summary, r.turns, r.minutes, r.trigger, s.name schedule
            FROM Run r LEFT JOIN Schedule s ON s.id = r.scheduleId ORDER BY r.startedAt DESC, r.id DESC LIMIT ?`).all(opt.all ? 100000 : 20)
        return out(rows, () => rows.map((r) => `${String(r.id).padStart(4)}  ${S.local(r.startedAt)}  ${r.status.padEnd(8)} ${clip(r.schedule ?? r.trigger, 12).padEnd(12)} ${clip(r.summary.replace(/\s+/g, ' '), 90)}`).join('\n') || '(no runs)')
    }
    if (sub === 'stop') {
        const id = int(pos[0] ?? die('run stop <id>'), 'id')
        const stopped = R.stop(db, id)
        return out({ id, stopped }, () => (stopped ? `run ${id} stopped` : `run ${id} was not running`))
    }
    if (sub === 'show') {
        const id = int(pos[0] ?? die('run show <id>'), 'id')
        const r = db.prepare('SELECT * FROM Run WHERE id = ?').get(id) ?? die(`no run ${id}`)
        const notes = db.prepare('SELECT n.*, i.key FROM Note n JOIN Item i ON i.id = n.itemId WHERE runId = ? ORDER BY n.id').all(id)
        return out({ ...r, notes }, () => [`run ${r.id}  ${r.status}  ${S.local(r.startedAt)} -> ${r.finishedAt ? S.local(r.finishedAt) : '…'}`, r.summary, '', r.report,
            ...notes.map((n) => `\n--- [${n.key}] ${n.body}`)].join('\n'))
    }
    die('run start | finish <id> | close-stale | list | show <id> | stop <id>')
}

function cmdPrompt() {
    const sub = pos.shift() ?? 'list'
    if (sub === 'list') {
        const rows = P.list(db)
        return out(rows, () => rows.map((p) => `${p.name.padEnd(22)} ${p.kind.padEnd(7)} ${String(p.size).padStart(6)} B  ${S.local(p.updatedAt)}`).join('\n') || '(no prompts)')
    }
    const name = pos.shift() ?? die(`prompt ${sub} <name>`)
    if (sub === 'show') {
        const p = P.must(db, name)
        if (J) return out(p, () => '')
        return process.stdout.write(p.body.endsWith('\n') ? p.body : p.body + '\n')
    }
    if (sub === 'set') {
        const body = opt.file ? readText(String(opt.file)) : readStdin()
        if (!body.trim()) die('empty body (pass --file F or pipe it in)')
        const r = P.set(db, name, body, { kind: opt.kind, author: opt.by ?? 'session', note: opt.note ? String(opt.note) : '' })
        return out(r, () => (r.changed ? `saved ${name}` : `${name} unchanged`))
    }
    if (sub === 'history') {
        const rows = P.history(db, name)
        return out(rows, () => rows.map((v) => `#${String(v.id).padEnd(5)} ${S.local(v.createdAt)}  ${v.author.padEnd(9)} ${String(v.size).padStart(6)} B  ${v.note}`).join('\n'))
    }
    die('prompt list | show <name> | set <name> | history <name>')
}

function cmdSchedule() {
    const sub = pos.shift() ?? 'list'
    if (sub !== 'list') die('schedule list   (schedules are edited in the panel)')
    const rows = R.schedules(db).map((s) => {
        const err = cronError(s.cron)
        return { ...s, enabled: !!s.enabled, allowOverlap: !!s.allowOverlap, error: err, next: err ? null : nextFires(s.cron, new Date(), 1)[0]?.toISOString() ?? null }
    })
    out(rows, () => rows.map((s) => `${String(s.id).padStart(3)}  ${s.enabled ? 'on ' : 'off'}  ${s.cron.padEnd(16)} ${clip(s.name, 24).padEnd(24)} ` +
        `${s.prompt.padEnd(12)} ${s.error ? `BAD: ${s.error}` : `next ${S.local(s.next)}`}`).join('\n') || '(no schedules)')
}

function cmdTick() {
    const lines = R.tick(db, new Date(), { dryRun: !!opt.dryRun })
    if (J) return out(lines, () => '')
    if (lines.length) process.stdout.write(lines.join('\n') + '\n')
}

function cmdStart() {
    const ref = pos.join(' ') || die('start <schedule-id|name>')
    const s = (/^\d+$/.test(ref) ? db.prepare('SELECT * FROM Schedule WHERE id = ?').get(Number(ref)) : null) ??
        db.prepare('SELECT * FROM Schedule WHERE name = ? COLLATE NOCASE').get(ref) ?? die(`no schedule "${ref}" (nightly schedule list)`)
    const r = R.fire(db, s, 'manual')
    out(r, () => (r.status === 'skipped' ? `${r.id} (skipped: another run is going)` : String(r.id)))
}

async function cmdExec() {
    const id = int(pos[0] ?? die('exec <run-id>'), 'id')
    process.exitCode = await R.exec(db, id)
}

function agentLine(a) {
    const claims = db.prepare('SELECT scope FROM Claim WHERE agentId = ? AND releasedAt IS NULL').all(a.id).map((c) => c.scope)
    return `${a.name.padEnd(20)} ${a.kind.padEnd(8)} seen ${S.local(a.lastSeenAt).slice(11)}  ${clip(a.task, 60)}${claims.length ? `\n${''.padEnd(30)}holds: ${claims.join(', ')}` : ''}`
}
const msgLine = (m) => `#${m.id} ${S.local(m.createdAt).slice(5)} ${m.author}${m.to ? ` -> ${m.to}` : ''}: ${m.body}`
const hint = (a) => {
    const n = A.unread(db, a)
    if (n && !J) process.stderr.write(`(${n} unread on the board: nightly agent inbox ${a.name})\n`)
}

function cmdAgent() {
    const sub = pos.shift() ?? 'board'
    if (sub === 'board') {
        const b = A.board(db)
        return out(b, () => [
            `LIVE AGENTS (${b.agents.length})`, ...(b.agents.length ? b.agents.map(agentLine) : ['(none)']),
            ...(b.claims.some((c) => c.stale) ? ['', 'STALE CLAIMS (holder silent > 60 min; they do not block)', ...b.claims.filter((c) => c.stale).map((c) => `${c.scope}  by ${c.name}, seen ${S.local(c.lastSeenAt)}`)] : []),
            '', 'RECENT MESSAGES', ...(b.messages.length ? b.messages.map(msgLine) : ['(none)']),
        ].join('\n'))
    }
    const name = pos.shift() ?? die(`agent ${sub} <name> ...`)
    if (sub === 'join') {
        const a = A.join(db, name, { kind: opt.kind ?? 'session', task: opt.task, repos: csv(opt.repos)?.join(', '), runId: opt.run ? int(opt.run, '--run') : undefined })
        const others = A.live(db).filter((o) => o.id !== a.id)
        return out({ agent: a, others, claims: A.activeClaims(db).filter((c) => c.agentId !== a.id) }, () => [
            `on the board as ${a.name}`,
            others.length ? `\nALSO LIVE\n${others.map(agentLine).join('\n')}` : 'nobody else is live',
            '\nClaim each repo before changing it: nightly agent claim ' + a.name + ' <path>',
        ].join('\n'))
    }
    const a = A.must(db, name)
    if (sub === 'claim') {
        if (!pos.length) die('agent claim <name> <path...>')
        const r = A.claim(db, a, pos, { note: opt.note ? String(opt.note) : '', force: !!opt.force })
        const who = (c) => `${c.scope} is held by ${c.name} (${c.kind}, seen ${S.local(c.lastSeenAt).slice(11)})${c.note ? ` -- ${c.note}` : ''}`
        out(r, () => [
            ...(r.ok ? [r.claimed.length ? `claimed ${r.claimed.join(', ')}` : 'already yours'] : ['NOT claimed:', ...r.blocking.map(who),
                `Coordinate first: nightly agent say ${a.name} --to ${r.blocking[0].name} "..."  (or work elsewhere; --force overrides)`]),
            ...(r.ok && r.blocking.length ? ['forced over:', ...r.blocking.map(who)] : []),
            ...(r.stale.length ? ['stale (holder silent, not blocking):', ...r.stale.map(who)] : []),
        ].join('\n'))
        hint(a)
        if (!r.ok) process.exitCode = 3
        return
    }
    if (sub === 'release') {
        const r = A.release(db, a, pos)
        out({ released: r }, () => (r.length ? `released ${r.join(', ')}` : 'nothing to release'))
        return hint(a)
    }
    if (sub === 'say') {
        const body = (pos.length ? pos.join(' ') : readStdin()).trim()
        if (!body) die('empty message')
        if (opt.to && !A.find(db, String(opt.to)) && opt.to !== 'christian') process.stderr.write(`note: no agent "${opt.to}" is on the board right now\n`)
        const m = A.post(db, a, body, { to: opt.to ? String(opt.to) : null })
        out(m, () => `posted #${m.id}`)
        return hint(a)
    }
    if (sub === 'inbox') {
        const rows = A.inbox(db, a, { mark: !opt.peek })
        return out(rows, () => (rows.length ? rows.map(msgLine).join('\n') : '(nothing new)'))
    }
    if (sub === 'leave') {
        const r = A.leave(db, a, opt.note ? String(opt.note) : '')
        return out({ released: r }, () => `left${r.length ? `, released ${r.join(', ')}` : ''}`)
    }
    die('agent join | claim | release | say | inbox | board | leave')
}

function cmdGet() {
    const key = pos[0] ?? die('get <key>')
    let v = S.getSetting(db, key)
    if (key === 'doRun') v = String(v ?? 'false').trim().toLowerCase() === 'true' ? 'true' : 'false'
    out({ key, value: v }, () => v ?? '')
}

function cmdSetSetting() {
    const [key, value] = pos
    if (!key || value === undefined) die('set-setting <key> <value>')
    const v = key === 'doRun' ? (/^(true|1|yes|on)$/i.test(value) ? 'true' : 'false') : value
    S.setSetting(db, key, v)
    out({ key, value: v }, () => `${key}=${v}`)
}

function cmdBrief() {
    const doRun = S.getSetting(db, 'doRun') === 'true'
    const due = S.checks(db).filter((c) => S.isDue(c))
    const by = (st) => db.prepare('SELECT * FROM Item WHERE status = ? AND kind != ? ORDER BY priority, id').all(st, 'check')
    const inProgress = by('in_progress')
    const review = by('review')
    const blocked = by('blocked')
    const queue = by('queue')
    const last = db.prepare("SELECT id, startedAt, status, summary FROM Run WHERE status != 'running' ORDER BY startedAt DESC, id DESC LIMIT 1").get()
    if (J) return out({ doRun, dueChecks: due, inProgress, review, blocked: blocked.map((b) => b.key), queue: queue.slice(0, 15), queueTotal: queue.length, lastRun: last ?? null }, () => '')
    const L = [`nightly brief ${S.local(S.now())}   doRun=${doRun}   (details: nightly show <key>)`]
    if (last) L.push(`last run #${last.id} ${day(last.startedAt)} ${last.status}: ${clip(last.summary.replace(/\s+/g, ' '), 300)}`)
    L.push('', `DUE CHECKS (${due.length})`)
    for (const c of due) {
        L.push(`- [${c.key}] ${c.title}  (${c.cadence}, last ${day(c.lastRunAt)})`)
        for (const l of firstLines(c.body, 2)) L.push(`    ${clip(l, 160)}`)
    }
    const short = (it) => `- [${it.key}] ${it.title}${it.repos ? `  {${clip(it.repos, 80)}}` : ''}`
    if (inProgress.length) L.push('', `IN PROGRESS (${inProgress.length})`, ...inProgress.map(short))
    if (review.length) L.push('', `REVIEW (${review.length})`, ...review.map(short))
    L.push('', `QUEUE (top ${Math.min(15, queue.length)} of ${queue.length}, in order)`)
    for (const it of queue.slice(0, 15)) {
        L.push(short(it))
        if (it.doneWhen) L.push(`    done when: ${clip(it.doneWhen, 180)}`)
    }
    if (blocked.length) L.push('', `BLOCKED: ${blocked.map((b) => b.key).join(', ')}`)
    process.stdout.write(L.join('\n') + '\n')
}

if (!cmd || opt.help || cmd === 'help') {
    process.stdout.write(HELP + '\n')
    process.exit(cmd || opt.help ? 0 : 1)
}

let db
try {
    db = S.open()
    const table = { list: cmdList, ls: cmdList, show: cmdShow, add: cmdAdd, set: cmdSet, note: cmdNote, checks: cmdChecks,
        checked: cmdChecked, run: cmdRun, get: cmdGet, 'set-setting': cmdSetSetting, brief: cmdBrief,
        prompt: cmdPrompt, prompts: cmdPrompt, schedule: cmdSchedule, schedules: cmdSchedule, tick: cmdTick, start: cmdStart, exec: cmdExec, agent: cmdAgent }
    const fn = table[cmd] ?? die(`unknown command "${cmd}" (try: nightly help)`)
    await fn()
} catch (e) {
    die(e?.message ?? String(e))
}
