// nightly -- CLI over the nightly to-do database. See README.md for the reference.
import '../lib/env.mjs'   // first: the other modules read process.env when they load
import { OWNER } from '../lib/owner.mjs'
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import * as A from '../lib/agents.mjs'
import * as Att from '../lib/attach.mjs'
import { cronError, nextFires } from '../lib/cron.mjs'
import * as P from '../lib/prompts.mjs'
import * as Rv from '../lib/review.mjs'
import * as R from '../lib/runner.mjs'
import * as S from '../lib/store.mjs'
import * as P_ from '../lib/perf.mjs'
import * as PS from '../lib/perf-store.mjs'
import * as PR from '../lib/perf-run.mjs'
import * as PG from '../lib/perf-gate.mjs'
import * as PV from '../lib/perf-viz.mjs'
import * as AS from '../lib/assets.mjs'
import * as ASC from '../lib/assets-cli.mjs'
import * as TH from '../lib/assets-thumbs.mjs'
import * as RSI from '../lib/rsi.mjs'
import * as US from '../lib/usage-store.mjs'
import * as UQ from '../lib/usage-query.mjs'
import * as UC from '../lib/usage-ch.mjs'
import { syncBlockers } from '../lib/rsi-blockers.mjs'
import { agentLive } from '../lib/cli-agents.mjs'
import { runTranscriptCommand, TRANSCRIPT_HELP } from '../lib/cli-transcripts.mjs'
import * as TS from '../lib/transcripts-store.mjs'
import { FEED_COMMANDS, FEED_HELP, runFeedCommand } from '../lib/cli-feeds.mjs'
import { GAMETOOLS_COMMANDS, GAMETOOLS_BOOL, GAMETOOLS_HELP, runGametoolsCommand, assetsUploadCmd } from '../lib/cli-gametools.mjs'
import { ACCOUNT_COMMANDS, ACCOUNT_BOOL, ACCOUNT_HELP, runAccountCommand } from '../lib/cli-accounts.mjs'

const argv = process.argv.slice(2)
const BOOL = new Set(['json', 'all', 'top', 'due', 'help', 'h', 'dryRun', 'force', 'peek', 'strict', 'register', 'noFindings', 'noBudgets', 'noBaseline', 'requireToken', 'tokenOnly', 'png', 'disable', 'enable', 'infra', 'leave', 'purge', 'wait', 'child', 'full', 'noCh', 'resync', 'missing', 'noCi', 'absolute', 'delete', 'noJournal', 'frame', 'fork', 'interrupt', ...ACCOUNT_BOOL, ...GAMETOOLS_BOOL])

const multi = {}
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
            if (k === 'budget') (multi.budget ??= []).push(v)
            if (k === 'metric') (multi.metric ??= []).push(v)
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
      [--priority N | --top | --after KEY] [--by <owner>|nightly|session (owner = NIGHTLY_OWNER)]
  set <key> [--status S] [--priority N | --top | --after KEY] [--title ..] [--body B | --body-file F]
      [--repos ..] [--done-when ..] [--kind ..] [--cadence ..]
  attach <key> <file.png|jpg> [--note ..] [--by ..]   store a screenshot on the item (max 1280 px wide, 2 MB, last 20 kept)
  attachments [--item KEY] [--json]            every screenshot on every item, newest first
  review new "TITLE" [--key K] | list | show KEY | open KEY | media KEY WEAPON FILE --slot filmstrip|clip|audio|image|screenshot [--variant before|after] [--label L] [--licence ..] [--source URL] [--title T] [--waveform W.png] [--look TEXT] [--metrics JSON] | verdict KEY WEAPON good|wrong [--note ..]
      a review item (kind review): per-weapon filmstrips/clips/audio and the verdict; open lists the weapons not yet good, with notes (--json)
  note <key> [--run ID] [--by nightly] <text | --file F | stdin>
  checks [--due]                                recurring checks (and which are due)
  checked <key> [--note ..] [--run ID]          stamp a check's lastRunAt
  run start | run finish <id> --status ok|failed|skipped --summary S [--report-file F] [--turns N] [--minutes N]
  run list | run show <id> | run stop <id>
  run close-stale --status ok|failed [--report-file F]   close runs still 'running' whose process is gone

  prompt list | show <name> | history <name>    the agent's prompts and the runner script (show prints the body)
  prompt set <name> [--file F | stdin] [--note N] [--by B] [--kind prompt|script]
  prompt rename <old> <new> [--kind script]     keep history and schedule links; a script is a job (no agent)

  schedule list                                 when the runner starts (edit in the panel)
  assets migrate                                create the assets (RSI) table (backs up the database to data/backup/ first)
  assets source add <name> --root DIR [--type pack|game] [--models GLOBS] [--textures GLOBS] [--sounds GLOBS] [--exclude DIRS] [--default-kind K] [--sound-kinds K,K] [--sound-match id-prefix|all|none] [--config JSON]
  assets source list|show <name>|set <name> [same flags, --disable|--enable]|rm <name> [--purge]|scan [name...]   asset sources (packs, games), stored in the database
  assets kind list|set <key> [--label L] [--sort N] [--match REGEX] [--budget JSON]|rm <key>   asset kinds and their audit budgets
  assets config                                 print the rsi-config/1 JSON (sources, kinds, tiers) the audit tool reads
  assets scan [name...]                         list every asset of the enabled sources by scanning their directories (never overwrites audited rows)
  assets ingest <audit.json|-> [--require-token|--token-only]   load rsi_asset_audit.py output (schema rsi-assets/2); token = NIGHTLY_PERF_TOKEN
  assets list [--pack P] [--kind K] [--game G] [--flag CODE] [--min-score N] [--max-score N] [--q TEXT] [--json]
  assets show <id|pack/weapon_id|weapon_id> [--json]     model, textures, animations, sounds, flags, score
  assets refresh                                run rsi_asset_audit.py for every texture tier (setting rsiTiers), ingest and sync findings (tick does this every rsiRefreshHours)
  rsi board|sync|refresh                        the RSI board: findings per domain; sync = stale/duplicate/blocked pass (auto-closes non-owner stale items)
  assets thumbs [id...] [--force] [--missing] [--limit N] [--wait]   (re)generate the 128x96 webp thumbnails (textures downscaled, models rendered in software, cached beside the audit data, regenerated when the file hash changes); runs detached unless --wait
  assets history [--pack P] [--limit N] [--json]   audit trend: one row per pack per ingest (oldest first; the history keeps counts and average score per pack, not per kind)
  assets summary                                per-pack counts and average score
${TRANSCRIPT_HELP}
  usage ingest [--full] [--dir D] [--no-ch] [--resync]   read Claude Code transcripts (usageDirs setting, default ~/.claude/projects) into the usage tables; pushes to ClickHouse when enabled
  usage summary [--days N] [--source ch]        tokens and estimated cost today/7d/30d/all
  usage top <project|session|agent_type|model|skill|tool|branch> [--days N] [--limit N] [--source ch]   biggest consumers
  usage cost [--days N]                         estimated cost by model     usage insights [--days N]   where the tokens go, with suggestions
  usage status | usage ch-setup                 what is configured / create the ClickHouse database and tables (never prints the password)
  perf migrate                                  create/upgrade the perf tables (backs up the database to data/backup/ first)
  perf token add --name N [--game G]            ingest token for one runner/game; the secret is printed once, only its hash is kept
  perf token list | perf token revoke NAME      (HTTP ingest needs "Authorization: Bearer <token>" once a token exists)
  perf gate --game X [--run ID|latest|COMMIT] [--no-budgets] [--no-baseline] [--noise-pct N]   pass/fail vs budgets and the noise-aware baseline; exit 0 pass, 1 fail, 2 no run
  perf report <runId> [--out DIR] [--png]       per-run perf report: markdown + svg (+ png via headless chromium) for READMEs/PRs
  perf diff <runA> <runB> [--out DIR] [--png]   differential flame graph (red = slower in B, green = faster) + the biggest changes
  perf shot add --run ID FILE.png [--name N] | perf shot list --run ID    screenshots attached to a run
  perf rsi [--game X]                           findings with state found -> fixed -> remeasured and the before/after delta
  perf game add --id X --name N [--repo R] [--repo-path DIR] [--engine godot] [--platforms native,web] [--owner O]
      [--budget "frame_ms_p95<=33@platform=native,role=client,map=arena,bots=4"]... [--routing JSON] [--addons JSON]
  perf game set --id X [same flags; --budgets JSON replaces the list] | perf game list | perf game show X
  perf ingest <report.json|.folded|.txt|-> --game X [--platform native|web] [--role client|server] [--map M] [--bots N]
      [--commit SHA] [--gpu S] [--resolution WxH] [--label L] [--register] [--no-findings] [--folded FILE]   (a v1 report plus its .folded gives the icicle view)
  perf run --game X [--platform native|web] [--role client|server] [--map M] [--bots N] [--dry-run]   runs tools/perf.sh, ingests
  perf nightly [--game X] [--dry-run]            the scheduled run: every routing entry of every enabled game
  perf runs [--game X] [--limit N] | perf compare <runA> <runB> | perf findings [--game X]
  perf finding add --game X --metric M [--item KEY | --title T]   link a perf finding to a queue item
${FEED_HELP}

  Users, projects and nodes (the panel's AdminCP does the same):
${ACCOUNT_HELP}
${GAMETOOLS_HELP}
  tick [--dry-run]                              crontab, every minute: fire the schedules due now
  start <schedule-id|name>                      fire one schedule now (ignores doRun); prints the run id

  agent join <name> [--task T] [--repos a,b] [--kind session|nightly] [--run ID]
  agent claim <name> <scope...> [--note N] [--force] [--item KEY] [--why W]
      exit 3 if a live agent holds an overlapping scope.
      scope = path, or <repo-claim>:<path-or-glob> (myhost:org/repo:scripts/**); a bare repo = whole repo
      Relaunch guard, on an agent's first claim: its item (--item, or an item key in its task) must not have another
      live agent, and the last agent on it must have left a commit sha (messages, leave note or item notes); else exit 4
      with that agent's stop note, unless --why says what changed (posted to the board).
  agent release <name> [<scope...>]              (no path = all of them)
  agent say <name> [--to AGENT] <text | stdin>
  agent inbox <name> [--peek]                   messages for you since you last looked
  agent board                                   who is live, what they hold, recent messages
  agent leave <name> [--note N]                 releases everything
  agent heartbeat <name> [--task T] [--kind K] [--repos a,b] [--leave]   register-or-refresh from any runner (HTTP: POST /api/agents/heartbeat)
  agent sweep | running                         retire agents silent past the agentLeftHours setting (12h) | list running agents that never registered
                                                (settings agentSourceCmd = a command, or agentSourceFile = a file; JSON array or "name task" lines)

  account status | pick | env | add <name>      which Claude account a run or session uses (scripts/claude-acct); set up in .env
      [--strict] [--exclude a,b]                pick/env only: exit 1 if no account is under its limits / leave these out
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
    const shots = Att.list(it.key)
    if (shots.length) {
        h.push('', `--- attachments (${shots.length})`)
        for (const a of shots) h.push(`${Att.urlFor(it.key, a.file)}  ${S.local(a.at)} by ${a.by}${a.note ? ` -- ${a.note}` : ''}`)
    }
    for (const n of notes) h.push('', `--- note ${S.local(n.createdAt)} by ${n.author}${n.runId ? ` (run ${n.runId})` : ''}`, n.body)
    return h.join('\n')
}

function cmdShow() {
    const key = pos[0] ?? die('show <key>')
    const it = S.mustItem(db, key)
    const notes = S.notesFor(db, it.id)
    const attachments = Att.list(it.key).map((a) => ({ ...a, url: Att.urlFor(it.key, a.file) }))
    out({ ...it, notes, attachments }, () => showItem(it, notes))
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

function cmdAttach() {
    const key = pos.shift() ?? die('attach <key> <file.png|jpg> [--note ..]')
    const file = pos.shift() ?? die('attach <key> <file.png|jpg> [--note ..]')
    S.mustItem(db, key)
    const a = Att.attach(key, file, { note: opt.note ? String(opt.note) : '', by: opt.by ?? 'session' })
    out(a, () => `attached to ${key}: ${a.url}  (${Math.round(a.bytes / 1024)} KB)`)
}

function cmdAttachments() {
    const rows = Att.listAll(opt.item ? String(opt.item) : "")
    out(rows, () => rows.map((a) => `${S.local(a.at)}  ${a.item}  by ${a.by}${a.note ? ` -- ${a.note}` : ""}\n    ${a.url}`).join("\n") || "(no attachments)")
}

function cmdReview() {
    const sub = pos.shift() ?? die('review new|list|show|open|media|verdict (see: nightly help)')
    if (sub === 'new') {
        const title = opt.title ?? (pos.length ? pos.join(' ') : die('review new "TITLE" [--key K]'))
        const it = S.addItem(db, { title: String(title), key: opt.key, kind: 'review', status: 'review', body: bodyOpt(true), addedBy: opt.by ?? 'session' })
        return out(it, () => `review ${it.key} created (panel: /reviews)`)
    }
    if (sub === 'list') {
        const rows = db.prepare("SELECT key, title, status FROM Item WHERE kind = 'review' ORDER BY id DESC").all()
            .map((r) => ({ ...r, open: Rv.open(r.key).length }))
        return out(rows, () => rows.map((r) => `${r.key}  ${r.title}  (${r.open} weapons not good)`).join('\n') || '(no reviews)')
    }
    const key = pos.shift() ?? die(`review ${sub} KEY ...`)
    S.mustItem(db, key)
    if (sub === 'show') {
        const d = Rv.load(key)
        for (const w of Object.values(d.weapons)) for (const m of w.media) m.url = Rv.urlFor(key, m.file)
        return out(d, () => Object.entries(d.weapons).map(([id, w]) => `${id}  [${w.verdict || 'unreviewed'}]${w.note ? ` ${w.note}` : ''}  (${w.media.length} media)`).join('\n') || '(empty)')
    }
    if (sub === 'open') {
        const rows = Rv.open(key)
        return out(rows, () => rows.map((r) => `${r.weapon}  [${r.verdict}]${r.note ? ` ${r.note}` : ''}`).join('\n') || 'all good')
    }
    const weapon = pos.shift() ?? die(`review ${sub} KEY WEAPON ...`)
    if (sub === 'media') {
        const file = pos.shift() ?? die('review media KEY WEAPON FILE --slot filmstrip|clip|audio|image|screenshot')
        const m = Rv.addMedia(key, weapon, file, {
            slot: String(opt.slot ?? die('--slot is required')), variant: opt.variant ? String(opt.variant) : '', label: opt.label ? String(opt.label) : '',
            licence: opt.licence ? String(opt.licence) : '', source: opt.source ? String(opt.source) : '', note: opt.note ? String(opt.note) : '',
            title: opt.title ? String(opt.title) : '', waveform: opt.waveform ? String(opt.waveform) : '', by: opt.by ?? 'session',
            look: opt.look ? String(opt.look) : '', metrics: opt.metrics ? String(opt.metrics) : null, entryLook: opt['entry-look'] ? String(opt['entry-look']) : '', entryMetrics: opt['entry-metrics'] ? String(opt['entry-metrics']) : null,
        })
        return out(m, () => `added ${m.file}: ${m.url}`)
    }
    if (sub === 'verdict') {
        const v = pos.shift() ?? die('review verdict KEY WEAPON good|wrong|clear [--note ..]')
        const r = Rv.setVerdict(key, weapon, v === 'clear' ? '' : v, { note: opt.note ? String(opt.note) : '', by: opt.by ?? OWNER })
        return out(r, () => `${key}/${r.weapon}: ${r.verdict || 'cleared'}`)
    }
    die(`unknown review command "${sub}"`)
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
        const stale = R.closeStale(db, status, report)
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
    if (sub === 'rename') {
        const to = pos.shift() ?? die('prompt rename <old> <new> [--kind script|prompt]')
        const r = P.rename(db, name, to, { kind: opt.kind })
        return out(r, () => `renamed ${name} -> ${to} (${r.kind}, ${r.schedules} schedule(s) updated)`)
    }
    if (sub === 'history') {
        const rows = P.history(db, name)
        return out(rows, () => rows.map((v) => `#${String(v.id).padEnd(5)} ${S.local(v.createdAt)}  ${v.author.padEnd(9)} ${String(v.size).padStart(6)} B  ${v.note}`).join('\n'))
    }
    die('prompt list | show <name> | set <name> | rename <old> <new> | history <name>')
}

const fmtTok = (n) => (n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)))
const usd = (x) => '$' + (x ?? 0).toFixed(2)

async function cmdUsage() {
    const sub = pos.shift() ?? die('usage ingest|summary|top|cost|insights|status|ch-setup')
    US.ensure(db)
    const prices = US.prices(db)
    const days = opt.days === undefined ? 0 : int(opt.days, '--days')
    const since = days ? Date.now() - days * 86_400_000 : 0
    let be = { dialect: 'sqlite', q: async (sql) => db.prepare(sql).all() }
    if (opt.source === 'ch') { const c = US.chConfigFrom(db); be = { dialect: 'ch', db: c.db, q: (sql) => UC.chQuery(c, sql) } }
    if (sub === 'ingest') {
        const st = await US.ingest(db, { full: !!opt.full, dirsOverride: opt.dir ? [String(opt.dir)] : undefined, ch: !opt.noCh, resync: !!opt.resync })
        return out(st, () => `${st.changed}/${st.files} files changed in ${st.dirs} dirs; ${st.messages} messages, ${st.tools} tool rows, ${st.events} events` +
            (st.unreadable ? `; ${st.unreadable} unreadable (check usageDirs and permissions)` : '') + (st.ch ? `; clickhouse +${Object.values(st.ch).reduce((a, b) => a + b, 0)} rows` : '') + (st.chError ? `\nclickhouse failed (rows stay queued): ${st.chError}` : ''))
    }
    if (sub === 'status') {
        const cfg = UC.publicConfig(US.chConfigFrom(db))
        const n = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n
        const st = { dirs: US.dirs(db), messages: n('usage_message'), tools: n('usage_tool'), events: n('usage_event'), files: n('usage_file'), lastIngestAt: S.getSetting(db, 'usageLastIngestAt'), clickhouse: cfg }
        return out(st, () => `dirs: ${st.dirs.join(', ')}\nrows: ${st.messages} messages, ${st.tools} tool calls, ${st.events} events from ${st.files} files; last ingest ${st.lastIngestAt ?? 'never'}\n` +
            `clickhouse: ${cfg.enabled ? 'enabled' : 'off'} ${cfg.url} db ${cfg.db} user ${cfg.user} password ${cfg.passwordSet ? `set (env ${cfg.passwordEnv})` : `NOT set (env ${cfg.passwordEnv})`}`)
    }
    if (sub === 'ch-setup') {
        const n = await US.ensureCh(US.chConfigFrom(db))
        return out({ ok: true, statements: n }, () => `clickhouse schema ready (${n} statements)`)
    }
    if (sub === 'summary') {
        const t = await UQ.totals(be, prices)
        return out(t, () => ['today', '7d', '30d', 'all'].map((k) => `${k.padEnd(6)} ${fmtTok(t[k].total).padStart(8)} tokens  ${String(t[k].messages).padStart(7)} msgs  ${usd(t[k].cost).padStart(10)}  (in ${fmtTok(t[k].input)}, out ${fmtTok(t[k].output)}, cache read ${fmtTok(t[k].cache_read)}, cache write ${fmtTok(t[k].cache_5m + t[k].cache_1h)})`).join('\n') + '\ncost is an estimate from the usagePrices table')
    }
    if (sub === 'top') {
        const dim = pos.shift() ?? die('usage top <project|session|agent_type|model|skill|tool|branch>')
        const r = await UQ.breakdown(be, prices, dim, { since })
        const lim = opt.limit ? int(opt.limit, '--limit') : 15
        return out({ ...r, rows: r.rows.slice(0, lim) }, () => r.rows.slice(0, lim).map((x) => `${clip(String(x.key), 38).padEnd(38)} ${fmtTok(x.total).padStart(8)} ${String(Math.round(x.share * 100)).padStart(3)}%` + (dim === 'tool' ? `  ${x.calls} calls, largest ${fmtTok(x.biggest)} (estimated)` : `  ${usd(x.cost).padStart(9)}`)).join('\n') || '(no data; run `nightly usage ingest`)')
    }
    if (sub === 'cost') {
        const r = await UQ.breakdown(be, prices, 'model', { since })
        return out(r, () => r.rows.map((x) => `${clip(x.key, 38).padEnd(38)} ${usd(x.cost).padStart(10)} ${fmtTok(x.total).padStart(8)} tokens`).join('\n') + `\ntotal ${usd(r.cost)} (estimate)`)
    }
    if (sub === 'insights') {
        const r = await UQ.insights(be, prices, { since, pollMin: US.setting(db, 'usagePollMin'), bigResultTokens: US.setting(db, 'usageBigResultTokens') })
        return out(r, () => r.map((i) => `[${i.level}] ${i.title}\n    ${i.detail}\n    -> ${i.suggestion}`).join('\n') || '(no data)')
    }
    die(`unknown usage subcommand "${sub}"`)
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

const ROOT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
async function cmdTranscript() {
    await runTranscriptCommand({ db, pos, opt, out, die, root: ROOT_DIR, idleMinutes: Number(S.getSetting(db, 'transcriptsIdleMinutes') ?? 30) })
}

async function cmdTick() {
    const lines = R.tick(db, new Date(), { dryRun: !!opt.dryRun })
    if (!opt.dryRun) { try { const m = PR.maybeSchedule(db); if (m) lines.push(m) } catch (e) { lines.push(`perf schedule: ${e.message}`) }
        try { lines.push(...RSI.tickHook(db)) } catch (e) { lines.push(`rsi: ${e.message}`) }
        try { lines.push(...await US.tickHook(db)) } catch (e) { lines.push(`usage: ${e.message}`) }
        try { TS.ensure(db); const r = TS.ingestAll(db); if (r.changed) lines.push(`transcripts: ${r.changed} files, ${r.added} entries`) } catch (e) { lines.push(`transcripts: ${e.message}`) } }
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
    if (agentLive(sub, { db, pos, opt, out, die })) return
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
        const r = A.claim(db, a, pos, { note: opt.note ? String(opt.note) : '', force: !!opt.force,
            item: opt.item ? String(opt.item) : '', why: opt.why ? String(opt.why) : '' })
        const who = (c) => `${c.scope} is held by ${c.name} (${c.kind}, seen ${S.local(c.lastSeenAt).slice(11)})${c.note ? ` -- ${c.note}` : ''}`
        const prev = (x) => x.why === 'live'
            ? `${x.key}: ${x.agent.name} is live on it (seen ${S.local(x.agent.lastSeenAt).slice(11)}, task: ${clip(x.agent.task, 60)})`
            : `${x.key}: the last agent, ${x.agent.name} (${S.local(x.agent.startedAt).slice(5, 16)}..${S.local(x.agent.endedAt).slice(11, 16)}), ` +
              `left no commit. Its stop note: ${x.agent.stopNote || '(none)'}`
        if (r.relaunch.length && !r.ok) {
            out(r, () => ['NOT claimed: relaunch guard', ...r.relaunch.map(prev),
                `Read \`nightly show ${r.relaunch[0].key}\` and the board, change the brief, then claim again with ` +
                `--why "<what is different this time>" (posted to the board). Or pick another item.`].join('\n'))
            process.exitCode = 4
            return
        }
        out(r, () => [
            ...(r.relaunch.length ? ['relaunch guard overridden (--why):', ...r.relaunch.map(prev)] : []),
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
        if (opt.to && !A.find(db, String(opt.to)) && opt.to !== OWNER) process.stderr.write(`note: no agent "${opt.to}" is on the board right now\n`)
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

// Several Claude accounts, chosen per run at launch. Configuration is CLAUDE_ACCOUNTS (and the
// CLAUDE_ACCT_* knobs) in .env; with one account every subcommand is a no-op, see scripts/claude-acct.
function cmdAccount() {
    const sub = pos.shift() ?? die('account status | pick | env | add <name>')
    if (!['status', 'pick', 'env', 'add'].includes(sub)) die('account status | pick | env | add <name>')
    // The thresholds are settings (Settings in the panel) and win over the .env file; unset, claude-acct's defaults apply.
    const fromSettings = {}
    for (const [setting, name] of [['accountMaxFiveHour', 'CLAUDE_ACCT_FIVE_MAX'], ['accountMaxWeekly', 'CLAUDE_ACCT_WEEK_MAX']]) {
        const v = S.getSetting(db, setting)
        if (v) fromSettings[name] = v
    }
    if (opt.strict) fromSettings.CLAUDE_ACCT_STRICT = '1'
    if (opt.exclude) fromSettings.CLAUDE_ACCT_EXCLUDE = String(opt.exclude)
    const r = spawnSync(path.join(S.ROOT, 'scripts', 'claude-acct'), [sub, ...pos], {
        stdio: 'inherit', env: { ...process.env, CLAUDE_ACCT_ENV: process.env.CLAUDE_ACCT_ENV || path.join(S.ROOT, '.env'), ...fromSettings },
    })
    process.exit(r.status ?? 1)
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

function cmdRsi(forced) {
    const sub = forced ?? pos.shift() ?? 'board'
    if (sub === 'refresh') {
        const r = RSI.refresh(db, { onLog: (m) => process.stderr.write(`rsi: ${m}\n`) })
        return out(r, () => `refreshed: maps ${JSON.stringify(r.maps)}; ingested ${JSON.stringify(r.ingested)}; findings ${JSON.stringify(r.tiers)}; fix items ${r.made.join(', ') || 'none new'}; blockers ${r.blockers.found} (${r.blockers.closed} closed)`)
    }
    if (sub === 'sync') { RSI.ensure(db); const r = syncBlockers(db); return out(r, () => `blockers: ${r.found} found, ${r.closed} auto-closed`) }
    if (sub === 'board') { const b = RSI.board(db); return out(b, () => b.map((d) => `${d.domain.padEnd(11)} ${String(d.open).padStart(4)} open  ${String(d.resolved).padStart(4)} resolved`).join('\n') || '(no findings: nightly assets refresh)') }
    die('rsi board|sync|refresh')
}

function cmdAssets() {
    const sub = pos.shift() ?? die('assets migrate|source|kind|config|scan|ingest|list|show|history|summary|thumbs')
    if (sub === 'migrate') { const bak = AS.migrate(db, { backup: true, dbPath: S.DB_PATH }); return out({ ok: true, backup: bak }, () => `assets table ready${bak ? `; database backed up to ${bak}` : ''}`) }
    if (sub === 'refresh') return cmdRsi('refresh')
    if (sub === 'source' || sub === 'sources') return ASC.sourceCmd(db, pos, opt, out, die)
    if (sub === 'kind' || sub === 'kinds') return ASC.kindCmd(db, pos, opt, out, die)
    if (sub === 'config') { const c = ASC.config(db); return out(c, () => JSON.stringify(c, null, 2)) }
    // a scan or an ingest adds rows with no preview: render those (only those) in the background, never blocking the caller
    const kickThumbs = () => { if (process.env.NIGHTLY_NO_AUTO_THUMBS) return; try { spawn(process.execPath, [process.argv[1], 'assets', 'thumbs', '--child', '--missing'], { detached: true, stdio: 'ignore', env: process.env }).unref() } catch { /* previews are optional */ } }
    if (sub === 'upload' || sub === 'uploads') return assetsUploadCmd(sub, { db, pos, opt, out, die })
    if (sub === 'scan') { const r = ASC.scanCmd(db, pos, opt, out); kickThumbs(); return r }
    if (sub === 'ingest') {
        const file = pos[0] ?? die('assets ingest <audit.json|->')
        const text = readText(file)
        if (!text.trim()) die('empty input')
        if (opt.requireToken || opt.tokenOnly) PS.authorizeIngest(db, process.env.NIGHTLY_PERF_TOKEN, '', { strict: !!opt.tokenOnly })
        let doc
        try { doc = JSON.parse(text) } catch (e) { die(`not JSON: ${e.message}`) }
        const r = AS.ingestAudit(db, doc, { auditDir: file === '-' ? undefined : path.dirname(path.resolve(file)) })
        kickThumbs()
        return out(r, () => `ingested: ${r.added} added, ${r.updated} updated, ${r.skipped} skipped`)
    }
    if (sub === 'list' || sub === 'ls') {
        const rows = AS.list(db, { pack: opt.pack, kind: opt.kind, game: opt.game, flag: opt.flag, minScore: opt.minScore != null ? Number(opt.minScore) : undefined, maxScore: opt.maxScore != null ? Number(opt.maxScore) : undefined, q: opt.q })
        return out(rows, () => rows.map((r) => `${String(r.id).padStart(4)}  ${r.pack.padEnd(22)} ${r.kind.padEnd(9)} ${r.weaponId.padEnd(26)} score ${String(r.score).padStart(3)} ${r.pass ? 'pass' : 'FAIL'}  tris ${String(r.tris).padStart(6)}  tex ${r.texCount}  anim ${r.animCount}  snd ${r.soundCount}  ${r.source}  ${r.flagCodes}`).join('\n') + `\n${rows.length} assets`)
    }
    if (sub === 'show') {
        const r = AS.show(db, pos[0] ?? die('assets show <id|pack/weapon_id>'))
        const d = r.data
        return out(r, () => [
            `${r.pack}/${r.weaponId}  (#${r.id}, ${r.source}${r.game ? ', games: ' + r.game : ''})  score ${r.score} ${r.pass ? 'pass' : 'FAIL'}  audited ${r.auditedAt || '-'}`,
            `model: ${d.model?.glb || '(none)'}  ${d.model?.tris} tris, ${d.model?.verts} verts, ${d.model?.materials} materials, bbox ${(d.model?.bbox ?? []).join(' x ')}`,
            `textures (${d.textures?.length ?? 0}):`, ...(d.textures ?? []).map((t) => `  ${t.name}  ${t.w}x${t.h} ${t.format} ${t.bytes} B  maps: ${(t.maps ?? []).join(',') || '-'}`),
            `animations (${d.animations?.length ?? 0}):`, ...(d.animations ?? []).map((a) => `  ${a.name}  ${a.length}s  ${a.tracks} tracks  ${(a.flags ?? []).join(',')}`),
            `sounds (${d.sounds?.length ?? 0}):`, ...(d.sounds ?? []).map((x) => `  ${x.name}  ${x.len}s  ${x.rate} Hz  ${x.bytes} B`),
            `flags (${d.flags?.length ?? 0}):`, ...(d.flags ?? []).map((f) => `  ${f.severity.padEnd(5)} ${f.code}  ${f.msg}`),
        ].join('\n'))
    }
    if (sub === 'history') {
        const rows = AS.history(db, { pack: opt.pack ? String(opt.pack) : undefined, limit: opt.limit ? int(opt.limit, '--limit') : 60 })
        return out(rows, () => rows.map((r) => `${S.local(r.at)}  ${r.pack.padEnd(24)} ${String(r.total).padStart(5)} assets  ${String(r.pass).padStart(5)} pass  avg ${String(r.avgScore).padStart(3)}`).join('\n') || '(no audit history yet: nightly assets refresh)')
    }
    if (sub === 'summary') {
        const rows = AS.summary(db, { kind: opt.kind })
        return out(rows, () => rows.map((r) => `${r.pack.padEnd(24)} ${String(r.weapons).padStart(4)} assets  ${r.pass ?? 0} pass  avg ${r.avg_score}  ${r.audited} audited`).join('\n'))
    }
    if (sub === 'thumbs') {
        // thumbnails: detached by default so a scan or a shell is never blocked; --wait runs in the foreground (also what the background child does)
        if (!opt.wait && !opt.child) {
            const child = spawn(process.execPath, [process.argv[1], 'assets', 'thumbs', '--child', ...(opt.force ? ['--force'] : []), ...(opt.missing ? ['--missing'] : []), ...(opt.limit ? ['--limit', String(opt.limit)] : []), ...pos], { detached: true, stdio: 'ignore', env: process.env })
            child.unref()
            return out({ ok: true, pid: child.pid }, () => `thumbnails generating in the background (pid ${child.pid}); add --wait to run in the foreground`)
        }
        AS.ready(db)
        return TH.generate(db, { force: !!opt.force, missing: !!opt.missing, limit: Number(opt.limit) || 0, ids: pos.length ? pos.map(Number).filter(Number.isInteger) : null }).then((r) => out(r, () => `${r.total} assets: ${r.made} made, ${r.fresh} up to date, ${r.none} without an image, ${r.error} failed`))
    }
    die('assets migrate|source|kind|config|scan|ingest|list|show|history|summary|thumbs')
}

function cmdPerf() {
    const sub = pos.shift() ?? die('perf migrate|game|ingest|run|nightly|runs|compare|findings|finding')
    const num = (v) => (v === undefined || v === true ? undefined : Number(v))
    const budgetsFrom = () => {
        const list = []
        if (opt.budgets) list.push(...JSON.parse(String(opt.budgets)))
        for (const b of [].concat(multi.budget ?? [])) list.push(b)
        return list.length ? list : undefined
    }
    const json = (v) => (v === undefined ? undefined : JSON.parse(String(v)))
    const gameFields = () => ({
        slug: opt.id, name: opt.name, repo: opt.repo, repoPath: opt.repoPath, engine: opt.engine, owner: opt.owner,
        platforms: opt.platforms, budgets: budgetsFrom(), routing: json(opt.routing), addons: json(opt.addons), perfScript: opt.script,
        enabled: opt.disable ? false : opt.enable ? true : undefined,
    })
    if (sub === 'migrate') { const bak = PS.migrate(db, { backup: true }); return out({ ok: true, backup: bak }, () => `perf tables ready${bak ? `; database backed up to ${bak}` : ''}`) }
    if (sub === 'token') {
        const a = pos.shift() ?? 'list'
        if (a === 'add') {
            const t = PS.addToken(db, { name: opt.name, game: opt.game ? String(opt.game) : '' })
            return out(t, () => `token "${t.name}"${t.game ? ` (game ${t.game})` : ' (any game)'}: ${t.token}\nshown once; only its hash is stored. Use: Authorization: Bearer <token>`)
        }
        if (a === 'revoke') { const r = PS.revokeToken(db, pos[0] ?? die('perf token revoke NAME')); return out(r, () => `revoked ${r.name}`) }
        const ts = PS.listTokens(db)
        return out(ts, () => ts.map((t) => `${t.name.padEnd(20)} ${t.prefix}...  ${(t.game || 'any game').padEnd(12)} ${t.revokedAt ? 'revoked ' + t.revokedAt.slice(0, 10) : 'active'}  used ${t.lastUsedAt?.slice(0, 16) ?? 'never'}`).join('\n') || '(no tokens: ingest is open)')
    }
    if (sub === 'rsi') {
        PS.ready(db)
        // Sync first: an item closed since the last ingest must show as fixed/dismissed without waiting for the next run (perf-rsi-cli-run-1).
        for (const g of PS.listGames(db)) if (!opt.game || g.slug === opt.game) PS.syncRsi(db, g)
        const rows = PS.listRsi(db, { game: opt.game ? String(opt.game) : undefined })
        return out(rows, () => rows.map((r) => `${r.game.padEnd(12)} ${r.state.padEnd(10)} ${(r.fn ? 'fn:' + r.fn : r.metric).padEnd(28)} ${r.itemKey || '-'} (${r.itemStatus || '-'})` +
            (r.delta != null ? `  ${+r.before.toFixed(3)} -> ${+r.after.toFixed(3)} (${r.delta > 0 ? '+' : ''}${+r.delta.toFixed(3)}${r.pct != null ? `, ${r.pct > 0 ? '+' : ''}${r.pct.toFixed(1)}%` : ''})` : '')).join('\n') || '(no findings)')
    }
    if (sub === 'game') {
        const a = pos.shift() ?? 'list'
        if (a === 'add' || a === 'set') {
            const g = PS.saveGame(db, gameFields(), { update: a === 'set' })
            return out(g, () => `${a === 'add' ? 'added' : 'updated'} game ${g.slug} (${g.budgets.length} budgets)`)
        }
        if (a === 'show') { const g = PS.getGame(db, pos[0] ?? die('perf game show <id>')) ?? die('no such game'); return out(g, () => JSON.stringify(g, null, 2)) }
        PS.ready(db)
        const gs = PS.listGames(db)
        return out(gs, () => gs.map((g) => `${g.slug.padEnd(14)} ${g.engine.padEnd(6)} ${g.platforms.join(',').padEnd(11)} ${String(g.budgets.length).padStart(2)} budgets  ${g.enabled ? '' : '(disabled) '}${g.name}`).join('\n') || '(no games: nightly perf game add --id ...)')
    }
    if (sub === 'ingest') {
        const file = pos[0] ?? die('perf ingest <file|-> --game X')
        const rawText = readText(file)
        if (!rawText.trim()) die('empty input')
        if (opt.requireToken || opt.tokenOnly) PS.authorizeIngest(db, process.env.NIGHTLY_PERF_TOKEN, opt.game ? String(opt.game) : '', { strict: !!opt.tokenOnly })
        const env = P_.splitEnvelope(rawText)
        const text = env.text
        const foldedText = env.folded || (opt.folded ? readText(String(opt.folded)) : '')
        const parsed = P_.parseAny(text, file === '-' ? String(opt.name ?? '') : file, { addons: PS.getGame(db, String(opt.game ?? ''))?.addons })
        const r = PS.ingest(db, parsed, {
            folded: foldedText || undefined,
            game: opt.game, platform: opt.platform, role: opt.role, map: opt.map, bots: opt.bots, commit: opt.commit, gpu: opt.gpu, resolution: opt.resolution,
            label: opt.label, build: opt.build, branch: opt.branch, ranAt: opt.at, duration: opt.duration, register: !!opt.register, noFindings: !!opt.noFindings, raw: parsed.kind === 'folded' ? undefined : text,
            source: opt.source ?? `ingest ${path.basename(file)}`,
        })
        return out(r, () => `run #${r.run.id} ${r.run.game} ${r.run.platform}/${r.run.role}: ${Object.keys(r.metrics).length} metrics, ${r.functions} functions` +
            r.breaches.map((b) => `\n  BREACH ${b.metric}=${+b.value.toFixed(3)} limit ${b.limit}`).join('') + r.findings.map((f) => `\n  finding -> ${f.itemKey || '(no item)'}${f.created ? ' (new)' : ''}`).join('') +
            r.regressions.map((f) => `\n  REGRESSION ${f.regressionOf} ${f.pct > 0 ? '+' : ''}${f.pct.toFixed(1)}% -> ${f.itemKey || '(no item)'}${f.created ? ' (new)' : ''}`).join('') + r.offenders.map((f) => `\n  offender ${f.fn} -> ${f.itemKey || '(no item)'}${f.created ? ' (new)' : ''}`).join(''))
    }
    if (sub === 'run' || sub === 'nightly') {
        if (sub === 'run') {
            const g = PS.getGame(db, String(opt.game ?? die('--game is required'))) ?? die(`no game "${opt.game}"`)
            const r = PR.runGame(db, g, { platform: opt.platform, role: opt.role, map: opt.map, bots: opt.bots, duration: opt.duration, dryRun: !!opt.dryRun })
            return out(r, () => (r.dryRun ? r.command : `run #${r.run.id}: ${r.breaches.length} breaches`))
        }
        const rows = PR.runAll(db, { dryRun: !!opt.dryRun, only: opt.game })
        return out(rows, () => rows.map((r) => `${r.game} ${r.combo ?? ''} ${r.status}${r.runId ? ' #' + r.runId : ''}${r.breaches ? ` ${r.breaches} breaches` : ''}${r.note ? ' ' + r.note : ''}${r.command ? ' ' + r.command : ''}`).join('\n') || '(no games)')
    }
    if (sub === 'runs') {
        const rs = PS.listRuns(db, { game: opt.game, limit: num(opt.limit) ?? 20 })
        return out(rs, () => rs.map((r) => `#${String(r.id).padEnd(5)} ${r.ranAt.slice(0, 16)} ${r.game.padEnd(12)} ${r.platform}/${r.role} ${r.map || '-'} bots=${r.bots} ${r.commit.slice(0, 9)} ${r.label}`).join('\n'))
    }
    if (sub === 'compare') {
        const [a, b] = [pos[0], pos[1]].map((x) => Number(x ?? die('perf compare <runA> <runB>')))
        const rows = P_.compareMetrics(PS.runMetrics(db, a), PS.runMetrics(db, b), { noisePct: num(opt.noise) ?? 5 })
        return out(rows, () => rows.map((r) => `${r.metric.padEnd(22)} ${String(r.a ?? '-').padStart(10)} ${String(r.b ?? '-').padStart(10)} ${r.pct === undefined || r.pct === null ? '' : (r.pct > 0 ? '+' : '') + r.pct.toFixed(1) + '%'} ${r.verdict}`).join('\n'))
    }
    if (sub === 'gate') {
        const game = String(opt.game ?? die('perf gate --game X [--run ID|latest|COMMIT] [--platform P --role R --map M --bots N] [--no-budgets] [--no-baseline] [--noise-pct N] [--sigma N] [--min-runs N] [--runs N] [--metric M]...   exit 0 pass, 1 fail, 2 no such run'))
        if (opt.requireToken || opt.tokenOnly) PS.authorizeIngest(db, process.env.NIGHTLY_PERF_TOKEN, game, { strict: !!opt.tokenOnly })
        const run = PG.findRun(db, game, String(opt.run ?? pos[0] ?? 'latest'), { platform: opt.platform, role: opt.role, map: opt.map, bots: opt.bots })
        if (!run) { process.stderr.write(`nightly: perf gate: no run of ${game} matches ${opt.run ?? 'latest'}\n`); process.exit(PG.EXIT.error) }
        const g = PG.gate(db, game, run.id, { budgets: !opt.noBudgets, baseline: !opt.noBaseline, noisePct: num(opt.noisePct), sigma: num(opt.sigma), minRuns: num(opt.minRuns), runs: num(opt.runs), metrics: [].concat(multi.metric ?? []) })
        out(g, () => PG.gateText(g))
        process.exit(g.exit)
    }
    if (sub === 'report' || sub === 'diff') {
        const dir = opt.out ? String(opt.out) : ''
        const save = (name, text) => { if (!dir) return ''; mkdirSync(dir, { recursive: true }); const f = path.join(dir, name); writeFileSync(f, text); return f }
        const png = (name, svg) => { if (!opt.png) return ''; if (!dir) die('--png needs --out DIR'); return PG.svgToPng(svg, path.join(dir, name)) }
        if (sub === 'report') {
            const id = Number(pos[0] ?? opt.run ?? die('perf report <runId> [--out DIR] [--png] [--image-url URL]'))
            const r = PG.runReport(db, id, { links: opt.imageUrl ? { image: String(opt.imageUrl) } : {} })
            const files = [save(`perf-run-${id}.md`, r.markdown), save(`perf-run-${id}.svg`, r.svg), png(`perf-run-${id}.png`, r.svg)].filter(Boolean)
            return out({ run: id, files, markdown: r.markdown }, () => (files.length ? files.map((f) => 'wrote ' + f).join('\n') : r.markdown))
        }
        const [ia, ib] = [pos[0], pos[1]].map((x) => Number(x ?? die('perf diff <runA> <runB> [--out DIR] [--png]   (red = B slower than A, green = faster)')))
        const [ra, rb] = [ia, ib].map((i) => db.prepare('SELECT * FROM PerfRun WHERE id = ?').get(i) ?? die(`no run ${i}`))
        const [fa, fb] = [PG.runFolded(db, ra), PG.runFolded(db, rb)]
        const svg = PV.diffFlameSvg(fa, fb, { title: `${ra.game}: run ${ia} -> run ${ib} (red = slower, green = faster)`, noisePct: num(opt.noise) ?? 5 })
        const rows = PV.diffRows(fa, fb, { top: Number(opt.top ?? 12) })
        const files = [save(`perf-diff-${ia}-${ib}.svg`, svg), png(`perf-diff-${ia}-${ib}.png`, svg)].filter(Boolean)
        return out({ a: ia, b: ib, rows, files }, () => [...files.map((f) => 'wrote ' + f), ...rows.map((r) => `${(r.delta >= 0 ? '+' : '') + (r.delta / 1000).toFixed(3).padStart(9)} ms  ${(r.a / 1000).toFixed(3)} -> ${(r.b / 1000).toFixed(3)}  ${r.path}`)].join('\n'))
    }
    if (sub === 'shot') {
        const a = pos.shift() ?? 'list'
        if (a === 'add') {
            const id = Number(opt.run ?? die('perf shot add --run ID FILE.png [--name N] [--note T]'))
            const f = pos[0] ?? die('perf shot add --run ID FILE.png|-')
            if (opt.requireToken || opt.tokenOnly) PS.authorizeIngest(db, process.env.NIGHTLY_PERF_TOKEN, db.prepare('SELECT game FROM PerfRun WHERE id = ?').get(id)?.game ?? '', { strict: !!opt.tokenOnly })
            const s = PS.addShot(db, id, readFileSync(f === '-' ? 0 : f), { name: opt.name ? String(opt.name) : f === '-' ? 'screenshot' : path.basename(f), note: opt.note ? String(opt.note) : '' })
            return out(s, () => `screenshot ${s.id} attached to run ${id} (${s.bytes} bytes)`)
        }
        const rows = PS.listShots(db, Number(opt.run ?? pos[0] ?? die('perf shot list --run ID')))
        return out(rows, () => rows.map((s) => `${String(s.id).padStart(4)} ${s.name.padEnd(30)} ${String(s.bytes).padStart(9)}  ${s.note}`).join('\n'))
    }
    if (sub === 'findings') {
        PS.ready(db)
        const rows = db.prepare(`SELECT f.*, i.status AS itemStatus FROM PerfFinding f LEFT JOIN Item i ON i.key = f.itemKey ${opt.game ? 'WHERE f.game = ?' : ''} ORDER BY f.updatedAt DESC`).all(...(opt.game ? [opt.game] : []))
        return out(rows, () => rows.map((f) => `${f.game.padEnd(12)} ${f.metric.padEnd(20)} ${f.status.padEnd(9)} ${f.itemKey || '-'} (${f.itemStatus ?? '-'})`).join('\n'))
    }
    if (sub === 'finding') {
        if (pos.shift() !== 'add') die('perf finding add --game X --metric M [--item KEY | --title T]')
        const f = PS.addFinding(db, { game: opt.game, metric: opt.metric, item: opt.item, title: opt.title, body: opt.body })
        return out(f, () => `${f.game}/${f.metric} -> ${f.itemKey}`)
    }
    die(`unknown perf command "${sub}"`)
}

if (!cmd || opt.help || cmd === 'help') {
    process.stdout.write(HELP + '\n')
    process.exit(cmd || opt.help ? 0 : 1)
}

let db
try {
    db = S.open()
    const table = { list: cmdList, ls: cmdList, show: cmdShow, add: cmdAdd, set: cmdSet, note: cmdNote, attach: cmdAttach, attachments: cmdAttachments, review: cmdReview, reviews: cmdReview, checks: cmdChecks,
        checked: cmdChecked, run: cmdRun, get: cmdGet, 'set-setting': cmdSetSetting, brief: cmdBrief,
        prompt: cmdPrompt, prompts: cmdPrompt, schedule: cmdSchedule, schedules: cmdSchedule, tick: cmdTick, start: cmdStart, exec: cmdExec, agent: cmdAgent, account: cmdAccount, accounts: cmdAccount, transcript: cmdTranscript, transcripts: cmdTranscript, perf: cmdPerf, assets: cmdAssets, rsi: cmdRsi, usage: cmdUsage }
    for (const c of [...FEED_COMMANDS, 'feed', 'gates']) table[c] = () => runFeedCommand(c, { db, pos, opt, out, die, readStdin })
    for (const c of GAMETOOLS_COMMANDS) table[c] = () => runGametoolsCommand(c, { db, pos, opt, out, die })
    for (const c of ACCOUNT_COMMANDS) table[c] ??= () => runAccountCommand(c, { db, pos, opt, out, die, readStdin })
    const fn = table[cmd] ?? die(`unknown command "${cmd}" (try: nightly help)`)
    await fn()
} catch (e) {
    die(e?.message ?? String(e))
}
