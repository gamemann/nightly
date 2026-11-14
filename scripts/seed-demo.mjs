#!/usr/bin/env node
// Fills a THROWAWAY database with neutral demo data (tasks, runs with reports, live agents, schedules,
// prompts, checks, QA runs, screenshots, a review) so the panel can be screenshotted for the README.
//
//   export NIGHTLY_DB=/tmp/nightly-demo/demo.db NIGHTLY_MEDIA=/tmp/nightly-demo/media \
//          NIGHTLY_ATTACH=/tmp/nightly-demo/attach NIGHTLY_REVIEWS=/tmp/nightly-demo/reviews
//   npm run db:push && node --no-warnings scripts/seed-demo.mjs
//   NIGHTLY_SCHEDULER=off npm run dev -- -p 3999
//
// It refuses to run without those variables (never seed data/nightly.db) and needs ImageMagick (`convert`) and
// ffmpeg (the review demo clips, filmstrips and sounds are drawn by ffmpeg's expression filters, no files from anywhere).
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import * as S from '../lib/store.mjs'
import * as A from '../lib/agents.mjs'
import * as P from '../lib/prompts.mjs'
import * as AT from '../lib/attach.mjs'
import * as R from '../lib/review.mjs'

if (!process.env.NIGHTLY_DB || !process.env.NIGHTLY_MEDIA || !process.env.NIGHTLY_ATTACH || !process.env.NIGHTLY_REVIEWS) {
    console.error('set NIGHTLY_DB, NIGHTLY_MEDIA, NIGHTLY_ATTACH and NIGHTLY_REVIEWS to scratch paths first (see the header)')
    process.exit(2)
}
const db = S.open()
if (db.prepare('SELECT COUNT(*) n FROM Item').get().n) { console.error('database is not empty; use a fresh one'); process.exit(2) }

const H = 3600_000, D = 24 * H
const ago = (ms) => new Date(Date.now() - ms).toISOString()
const me = 'gamemann'

// ---- tiny PNG writer (a gradient with a light box: placeholder "screenshots") ----
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]) }
function png(file, w, h, hue) {
    const raw = Buffer.alloc((w * 3 + 1) * h)
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const o = y * (w * 3 + 1) + 1 + x * 3
            const box = x > w * 0.3 && x < w * 0.7 && y > h * 0.35 && y < h * 0.85
            const t = (x / w + y / h) / 2
            const c = box ? [235, 235, 245] : [30 + hue[0] * t, 30 + hue[1] * t, 60 + hue[2] * t]
            raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2]
        }
    }
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
}

// ---- settings ----
for (const [k, v] of Object.entries({ doRun: 'true', usageMaxFiveHour: '80', usageMaxWeekly: '90', accountMaxFiveHour: '90', accountMaxWeekly: '98', spillMaxRestarts: '3' })) S.setSetting(db, k, v)

// ---- prompts ----
P.set(db, 'nightly.md', `# Nightly run

You are an autonomous worker for the **web-app** project. Work through the queue from the top.

1. Run \`nightly agent join <name>\` and read the board before touching anything.
2. Claim the paths you will edit (\`nightly agent claim\`); if a live agent holds them, take the next item.
3. Do the item, run the tests for what you touched, commit, and add a note with \`nightly note\`.
4. Finish with a short report: what changed, what was checked, what is left.

Never push to a protected branch. Stop when the usage check says so.
`, { author: me, note: 'first version', at: ago(9 * D) })
P.set(db, 'nightly.md', `# Nightly run

You are an autonomous worker for the **web-app** and **api** projects. Work through the queue from the top.

1. Run \`nightly agent join <name>\` and read the board before touching anything.
2. Claim the paths you will edit (\`nightly agent claim\`); if a live agent holds them, take the next item.
3. Do the item, run the tests for what you touched, commit, and add a note with \`nightly note\`.
4. Finish with a short report: what changed, what was checked, what is left.

## Rules
- Never push to a protected branch; open a pull request instead.
- Leave a failing check as an issue with the command that reproduces it.
- Stop when the usage check says so.
`, { author: me, note: 'add rules', at: ago(2 * D) })
P.set(db, 'weekly-review.md', `# Weekly review

Read every item closed this week. List what shipped, what slipped, and the three riskiest open items. Keep it under 40 lines.
`, { author: me, at: ago(6 * D) })
P.set(db, 'dependency-audit.md', `# Dependency audit

Run \`npm audit\` and \`npm outdated\` in each repo. File one issue per vulnerable package with the fix version.
Do not upgrade majors in this run.
`, { author: me, at: ago(4 * D) })
P.set(db, 'run.sh', `#!/usr/bin/env bash
# Runner: starts one Claude Code session with the schedule's prompt.
set -euo pipefail
claude -p "$(nightly prompt show "\${NIGHTLY_PROMPT:-nightly.md}")" --max-turns "\${NIGHTLY_MAX_TURNS:-400}"
`, { kind: 'script', author: me, at: ago(9 * D) })

// ---- schedules ----
const sch = (name, cron, prompt, instructions, maxTurns, enabled, last) => Number(db.prepare('INSERT INTO Schedule (name, cron, enabled, prompt, instructions, maxTurns, allowOverlap, lastFiredAt, createdAt, updatedAt) VALUES (?,?,?,?,?,?,0,?,?,?)').run(name, cron, enabled ? 1 : 0, prompt, instructions, maxTurns, last, ago(12 * D), ago(2 * D)).lastInsertRowid)
const sNight = sch('Nightly queue', '0 2 * * *', 'nightly.md', 'Focus on the web-app and api repos. Skip anything marked blocked.', 400, true, ago(7 * H))
const sWeek = sch('Weekly review', '0 9 * * 1', 'weekly-review.md', '', 120, true, ago(3 * D))
const sAudit = sch('Dependency audit', '30 3 * * 0', 'dependency-audit.md', 'Report only; open no pull requests.', 150, true, ago(5 * D))
sch('Release notes (paused)', '0 16 * * 5', 'weekly-review.md', 'Draft the changelog for the week.', 80, false, ago(21 * D))

// ---- items ----
const it = (o) => S.addItem(db, { addedBy: me, ...o })
it({ key: 'api-rate-limit', title: 'Add per-key rate limiting to the public API', status: 'in_progress', repos: 'api', doneWhen: 'Requests over the limit get 429 with a Retry-After header; tests cover the burst case.', body: `Clients can currently hammer \`/v1/search\`. Add a token bucket per API key.

- Limit and window come from config, \`0\` means unlimited.
- Return \`429\` with \`Retry-After\`.
- Add a test for a burst and for two keys not sharing a bucket.` })
it({ key: 'web-dark-mode', title: 'Dark mode for the settings pages', status: 'in_progress', repos: 'web-app', body: 'Use the existing colour tokens; do not add a second palette.' })
it({ key: 'web-form-validation', title: 'Validate the signup form on the client', status: 'review', repos: 'web-app', doneWhen: 'Errors show under each field; the submit button stays disabled until the form is valid.' })
it({ key: 'api-pagination', title: 'Cursor pagination for /v1/orders', status: 'review', repos: 'api' })
it({ key: 'docs-quickstart', title: 'Rewrite the quickstart for the 2.0 release', status: 'queue', repos: 'docs', body: 'Five minutes from clone to first request. Include the Docker route.' })
it({ key: 'mobile-push-tokens', title: 'Refresh push tokens on app start', status: 'queue', repos: 'mobile-app' })
it({ key: 'api-openapi-spec', title: 'Publish the OpenAPI spec from CI', status: 'queue', repos: 'api,docs' })
it({ key: 'web-a11y-audit', title: 'Fix the keyboard focus order on the dashboard', status: 'queue', repos: 'web-app' })
it({ key: 'api-cache-headers', title: 'Send ETag and Cache-Control on static lookups', status: 'queue', repos: 'api' })
it({ key: 'mobile-offline', title: 'Offline queue for the share action', status: 'blocked', repos: 'mobile-app', body: 'Waiting on the backend to accept idempotency keys.' })
it({ key: 'web-search-slow', title: 'Search results take 4 s on large accounts', kind: 'issue', status: 'queue', repos: 'web-app,api', body: 'Reported on accounts with more than 50k records. Profile the query first.' })
it({ key: 'api-flaky-webhook-test', title: 'Webhook retry test fails about one run in ten', kind: 'issue', status: 'queue', repos: 'api' })
it({ key: 'study-queue-backends', title: 'Compare Redis streams and SQS for the job queue', kind: 'study', status: 'queue', repos: 'api', body: 'Cost, ordering guarantees, operational weight. One page, a recommendation at the end.' })
it({ key: 'api-login-throttle', title: 'Throttle failed logins per IP', status: 'done', repos: 'api' })
it({ key: 'web-empty-states', title: 'Empty states for the project list', status: 'done', repos: 'web-app' })
it({ key: 'docs-changelog-format', title: 'Adopt Keep a Changelog for releases', status: 'done', repos: 'docs' })
it({ key: 'api-drop-v0', title: 'Remove the deprecated v0 endpoints', status: 'done', repos: 'api' })
it({ key: 'web-upgrade-react', title: 'Upgrade to React 19', status: 'done', repos: 'web-app' })
const chk = (key, title, cadence, repos, lastH, text) => it({ key, title, kind: 'check', cadence, repos, lastRunAt: lastH == null ? null : ago(lastH * H), body: text })
chk('check-tests-green', 'All test suites pass on main', 'nightly', 'web-app,api', 6, 'Run the suites; open an issue for every failure.')
chk('check-no-secrets', 'No secrets in the repositories', 'nightly', 'web-app,api,mobile-app', 30, 'Run the secret scanner over the files changed since the last check.')
chk('check-deps', 'Dependencies have no known vulnerabilities', 'weekly', 'web-app,api', 5 * 24, 'npm audit in each repo.')
chk('check-docs-links', 'No broken links in the docs', 'weekly', 'docs', 2 * 24, 'Crawl the built docs.')
chk('check-bundle-size', 'Web bundle stays under budget', 'every-2-days', 'web-app', 20, 'Compare against the budget in the build config.')
chk('check-license', 'Dependency licences are compatible', 'monthly', 'web-app,api', 12 * 24, '')
// a few items filed under demo "games" so the sidebar's Games section has entries
it({ key: 'hide-n-seek-spawns', title: 'Spread the hider spawn points', status: 'queue', repos: 'game-hide-n-seek' })
it({ key: 'murder-vote-ui', title: 'Voting screen for the discussion phase', status: 'in_progress', repos: 'game-murder-mystery' })
it({ key: 'wipeout-checkpoints', title: 'Checkpoint respawn after a fall', status: 'done', repos: 'mg-wipeout' })
// spread creation and update times
const items = db.prepare('SELECT id, status FROM Item').all()
items.forEach((r, i) => { const t = ago((i % 9 + 1) * 6 * H); db.prepare('UPDATE Item SET createdAt = ?, updatedAt = ?, completedAt = CASE WHEN status = ? THEN ? ELSE completedAt END WHERE id = ?').run(ago((i % 7 + 3) * D), t, 'done', t, r.id) })

// ---- runs with reports ----
const run = (o) => Number(db.prepare('INSERT INTO Run (startedAt, finishedAt, status, summary, report, log, turns, minutes, costUsd, trigger, scheduleId) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(o.start, o.end ?? null, o.status, o.summary ?? '', o.report ?? '', o.log ?? '', o.turns ?? null, o.minutes ?? null, o.cost ?? null, o.trigger ?? 'cron', o.sched ?? null).lastInsertRowid)
const rep1 = `# Nightly run: 5 items closed

## Done
- **api-login-throttle**: failed logins are limited to 10 per 15 minutes per IP; the limiter is in \`api/src/auth/throttle.ts\`.
- **web-empty-states**: the project list, the activity feed and the search page have empty states with a call to action.

## Checks
| Check | Result |
| --- | --- |
| Test suites on main | pass (412 tests) |
| Secret scan | clean |
| Bundle size | 184 kB, budget 200 kB |

## Left
- \`web-search-slow\` needs a profile of the query on a large account before any change.
- \`mobile-offline\` is still blocked on idempotency keys in the API.
`
const rep2 = `# Nightly run: partial

Stopped at the 5-hour usage limit after three items.

## Done
- **docs-changelog-format**: the changelog now follows Keep a Changelog; the release script reads it.
- **api-drop-v0**: v0 endpoints removed, clients get 410 with a link to the migration guide.

## Not done
- \`web-upgrade-react\` is half-way: the type errors in the form library remain.
`
const rA = run({ start: ago(7 * H + 52 * 60_000), end: ago(7 * H), status: 'ok', summary: 'Closed 5 items, all checks green', report: rep1, turns: 212, minutes: 52, cost: 18.4, sched: sNight, log: '[02:00] usage ok: 5h 21%, weekly 48%\n[02:01] joined board as nightly-1\n[02:03] claimed api/src/auth/**\n[02:41] tests pass (412)\n[02:52] report written\n' })
run({ start: ago(1 * D + 7 * H + 40 * 60_000), end: ago(1 * D + 7 * H), status: 'ok', summary: 'Stopped at the 5-hour limit after 3 items', report: rep2, turns: 160, minutes: 40, cost: 13.1, sched: sNight })
run({ start: ago(2 * D + 7 * H + 20 * 60_000), end: ago(2 * D + 7 * H), status: 'skipped', summary: 'Weekly usage at 91%, over the 90% limit', turns: 0, minutes: 0.2, cost: 0, sched: sNight })
run({ start: ago(3 * D + 17 * H), end: ago(3 * D + 16 * H + 40 * 60_000), status: 'ok', summary: 'Weekly review written: 9 shipped, 3 slipped', report: '# Weekly review\n\n## Shipped\n- Login throttling\n- Empty states\n- Changelog format\n\n## Riskiest open\n1. `mobile-offline` (blocked)\n2. `web-search-slow` (unprofiled)\n3. `api-flaky-webhook-test` (flaky)\n', turns: 54, minutes: 20, cost: 4.2, sched: sWeek })
run({ start: ago(3 * D + 7 * H), end: ago(3 * D + 6 * H + 12 * 60_000), status: 'failed', summary: 'Runner exited: claude CLI not logged in', report: 'The usage probe could not read the plan. Log in with `claude` on the runner host and start the schedule again.', turns: 2, minutes: 3, cost: 0.1, trigger: 'manual', sched: sNight })
run({ start: ago(5 * D + 22 * H), end: ago(5 * D + 21 * H + 10 * 60_000), status: 'ok', summary: 'Audit: 2 vulnerable packages filed as issues', report: '# Dependency audit\n\n- `semver` < 7.5.2 in api: issue filed.\n- `postcss` < 8.4.31 in web-app: issue filed.\n', turns: 70, minutes: 50, cost: 5.6, sched: sAudit })
run({ start: ago(4 * D + 7 * H), end: ago(4 * D + 6 * H), status: 'ok', summary: 'Closed 4 items', report: '# Nightly run\n\nFour items closed; see the item notes.', turns: 180, minutes: 60, cost: 15.0, sched: sNight })
const rLive = run({ start: ago(26 * 60_000), status: 'running', turns: 74, minutes: 26, trigger: 'manual', sched: sNight, log: 'usage ok: 5h 34%, weekly 52%\njoined board as nightly-2\nclaimed api/src/ratelimit/**\nworking on api-rate-limit\n' })
S.addNote(db, 'api-login-throttle', 'Limiter added with a sliding window per IP. Tests cover the lockout and the reset.', { runId: rA, createdAt: ago(7 * H + 5 * 60_000) })
S.addNote(db, 'web-empty-states', 'Added three empty states. Screenshots attached.', { runId: rA, createdAt: ago(7 * H + 20 * 60_000) })
S.addNote(db, 'web-form-validation', 'Ready for review: error text matches the design.', { runId: rA, createdAt: ago(7 * H + 30 * 60_000) })
S.addNote(db, 'check-tests-green', 'All suites pass (412 tests).', { runId: rA, createdAt: ago(7 * H + 2 * 60_000) })
S.addNote(db, 'docs-changelog-format', 'Release script now reads CHANGELOG.md.', { runId: rA, createdAt: ago(1 * D + 8 * H) })
S.addNote(db, 'api-rate-limit', 'Token bucket in place; writing the burst test now.', { runId: rLive, author: 'nightly-2' })
S.addNote(db, 'web-search-slow', 'Looks like a missing index on records(account_id, updated_at). Needs a profile to confirm.', { author: me, createdAt: ago(1 * D) })

// ---- live agents and the board ----
const live = (name, kind, task, repos, minsAgo, claims) => {
    const a = A.join(db, name, { kind, task, repos })
    db.prepare('UPDATE Agent SET startedAt = ?, lastSeenAt = ?, runId = ? WHERE id = ?').run(ago(minsAgo * 60_000), ago(20_000), kind === 'nightly' ? rLive : null, a.id)
    for (const [scope, note] of claims) A.claim(db, a, [scope], { note })
    return a
}
const n2 = live('nightly-2', 'nightly', 'api-rate-limit: per-key rate limiting', 'api', 26, [['api:src/ratelimit/**', 'token bucket'], ['api:test/ratelimit/**', 'burst test']])
const s1 = live('gamemann-session', 'session', 'Dark mode for the settings pages', 'web-app', 48, [['web-app:src/settings/**', 'theme tokens']])
const s2 = live('docs-writer', 'session', 'Quickstart rewrite', 'docs', 15, [['docs:guides/quickstart.md', ''], ['docs:static/img/**', 'new screenshots']])
const old = A.join(db, 'api-cleanup', { kind: 'session', task: 'Remove v0 endpoints', repos: 'api' })
A.leave(db, old, 'done, merged')
db.prepare('UPDATE Agent SET startedAt = ?, endedAt = ? WHERE id = ?').run(ago(5 * H), ago(3 * H), old.id)
const say = (a, text, minsAgo, to = null) => { const m = A.post(db, a, text, { to }); db.prepare('UPDATE Message SET createdAt = ? WHERE id = ?').run(ago(minsAgo * 60_000), m.id) }
say(s1, 'I am in web-app/src/settings; I will not touch the shared theme file.', 40)
say(n2, 'api-rate-limit: the limiter reads its limits from config. Anyone changing config/defaults.ts, shout.', 22)
say(s2, 'Quickstart will link to /v1/search. Is the route name final?', 12, 'nightly-2')
say(n2, 'Final. The 429 response shape is documented in the item.', 10, 'docs-writer')
say(s1, 'Dark mode: settings pages done, starting the dashboard next.', 3)
db.prepare("UPDATE Message SET createdAt = ? WHERE author = 'board'").run(ago(30 * 60_000))

// ---- QA runs ----
const qa = (kind, game, ok, total, failed, hAgo, commit, failures = []) => db.prepare('INSERT INTO QaRun (kind, game, "commit", ranAt, ok, total, failedCount, summary, failures, images, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(kind, game, commit, ago(hAgo * H), ok ? 1 : 0, total, failed, JSON.stringify({ total, failed }), JSON.stringify(failures), '[]', ago(hAgo * H))
const hex = (n) => ((n + 7) * 0x9e3779b1 >>> 0).toString(16).padStart(8, 'a').repeat(5).slice(0, 40)
for (let i = 0; i < 14; i++) qa('suite', 'web-app', i !== 5 && i !== 9, 412, i === 5 ? 3 : i === 9 ? 1 : 0, (13 - i) * 20 + 2, hex(i), i === 5 ? [{ name: 'signup form > shows a server error', reasons: ['expected 1 error, found 0'] }] : [])
for (let i = 0; i < 10; i++) qa('suite', 'api', true, 288, 0, (9 - i) * 20 + 3, hex(i + 40))
for (let i = 0; i < 8; i++) qa('visual', 'web-app', i !== 6, 24, i === 6 ? 2 : 0, (7 - i) * 22 + 1, hex(i + 80), i === 6 ? [{ name: 'dashboard (dark)' }, { name: 'settings (narrow)' }] : [])

// ---- screenshots: item attachments and dated media ----
const tmp = path.join(path.dirname(process.env.NIGHTLY_DB), 'tmp')
const shot = (name, hue) => { const f = path.join(tmp, `${name}.png`); png(f, 960, 600, hue); return f }
AT.attach('web-empty-states', shot('empty-projects', [60, 90, 200]), { note: 'Empty project list', by: 'nightly' })
AT.attach('web-empty-states', shot('empty-activity', [200, 90, 140]), { note: 'Empty activity feed', by: 'nightly' })
AT.attach('web-form-validation', shot('signup-errors', [220, 80, 80]), { note: 'Signup form with errors', by: 'nightly' })
AT.attach('web-dark-mode', shot('settings-dark', [40, 60, 120]), { note: 'Settings page in dark mode', by: 'nightly' })
const day = new Date().toISOString().slice(0, 10)
png(path.join(process.env.NIGHTLY_MEDIA, day, 'run-1', 'dashboard.png'), 960, 600, [90, 200, 120])
png(path.join(process.env.NIGHTLY_MEDIA, day, 'run-1', 'settings.png'), 960, 600, [200, 160, 60])
png(path.join(process.env.NIGHTLY_MEDIA, day, 'run-2', 'checkout.png'), 960, 600, [120, 90, 220])

// ---- a review item with verdicts ----
it({ key: 'review-onboarding', title: 'Onboarding screens: before and after', kind: 'review', status: 'review', repos: 'web-app' })
for (const [id, title, hue] of [['welcome', 'Welcome screen', [60, 140, 220]], ['invite', 'Invite teammates', [60, 200, 140]]]) {
    R.addMedia('review-onboarding', id, shot(`${id}-before`, [80, 80, 80]), { slot: 'screenshot', variant: 'before', label: 'before', title, by: 'nightly' })
    R.addMedia('review-onboarding', id, shot(`${id}-after`, hue), { slot: 'screenshot', variant: 'after', label: 'after', title, by: 'nightly' })
}
R.setVerdict('review-onboarding', 'welcome', 'good', { note: 'Reads well on a phone.', by: me })
R.setVerdict('review-onboarding', 'invite', 'wrong', { note: 'The invite button is below the fold on small screens.', by: me })

// ---- review items with generated clips, filmstrips and sounds (all drawn here with ffmpeg) ----
const ff = (...args) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' }); if (r.status !== 0) throw new Error('ffmpeg failed: ' + r.stderr) }
const media = path.join(tmp, 'review-media')
mkdirSync(media, { recursive: true })
// A shaded sphere that bounces or orbits, on a soft floor; `fps` low and `sat` low make the "before" version.
function sphere(name, motion, { fps = 30, dark = false, secs = 3 } = {}) {
    const cx = motion === 'orbit' ? '(W/2+sin(T*3)*140)' : '(W/2)'
    const cy = motion === 'orbit' ? '(H*0.55+cos(T*3)*30)' : '(H*0.72-abs(sin(T*5))*H*0.42)'
    const d = `hypot(X-${cx},Y-${cy})`, hl = `clip(1-hypot(X-${cx}+22,Y-${cy}+24)/70,0,1)`
    const sh = `clip(1-hypot((X-${cx})/1.6,(Y-H*0.86)*4)/(70-abs(sin(T*5))*30),0,1)`
    const body = (a, b, c) => `if(lt(${d},64),${a}+${b}*${hl}+40*(1-${d}/64),${c})`
    const col = dark ? [[140, 120, 30], [135, 120, 30]] : [[60, 170, 30], [110, 120, 41]]
    const f = `geq=r='${body(col[0][0], col[0][1], '30+20*(Y/H)-25*' + sh)}':g='${body(col[1][0], col[1][1], '41+22*(Y/H)-30*' + sh)}':b='${body(dark ? 150 : 230, dark ? 100 : 25, '59+30*(Y/H)-35*' + sh)}'`
    const out = path.join(media, `${name}.webm`)
    ff('-f', 'lavfi', '-i', `color=c=black:s=480x480:r=30:d=${secs},format=gbrp`, '-vf', `${f},fps=${fps},format=yuv420p`, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '38', out)
    return out
}
function strip(name, clip) { // eight frames side by side, as a still PNG
    const out = path.join(media, `${name}.png`)
    ff('-i', clip, '-vf', 'fps=2.6,scale=200:-2,tile=8x1', '-frames:v', '1', out)
    return out
}
function tone(name, expr, secs) {
    const out = path.join(media, `${name}.wav`)
    ff('-f', 'lavfi', '-i', `aevalsrc='${expr}':d=${secs}:s=44100`, out)
    return out
}
it({ key: 'motion-pass', title: 'Character motion pass: bounce and orbit', kind: 'review', status: 'review', repos: 'web-app', body: 'Second pass after the timing notes. Every entry has the old clip as before and the new one as after: drag the slider, or flip between the two and step through frames.' })
const bounceAfter = sphere('bounce-after', 'bounce'), orbitAfter = sphere('orbit-after', 'orbit')
R.addMedia('motion-pass', 'bounce', sphere('bounce-before', 'bounce', { fps: 8, dark: true }), { slot: 'clip', variant: 'before', label: 'side view', title: 'Bounce', look: 'Smooth arc, a short hang at the top, the shadow shrinking with height.', metrics: { fps: 8, frames: 24 }, by: 'nightly' })
R.addMedia('motion-pass', 'bounce', bounceAfter, { slot: 'clip', variant: 'after', label: 'side view', metrics: { fps: 30, frames: 90 }, by: 'nightly' })
R.addMedia('motion-pass', 'bounce', strip('bounce-strip', bounceAfter), { slot: 'filmstrip', variant: 'after', label: 'timing strip', by: 'nightly' })
R.addMedia('motion-pass', 'orbit', orbitAfter, { slot: 'clip', variant: 'after', label: 'top view', title: 'Orbit', look: 'Constant speed, no pop at the loop point.', metrics: { fps: 30, frames: 90 }, by: 'nightly' })
R.addMedia('motion-pass', 'orbit', sphere('orbit-before', 'orbit', { fps: 10, dark: true }), { slot: 'clip', variant: 'before', label: 'top view', metrics: { fps: 10, frames: 30 }, by: 'nightly' })
R.setVerdict('motion-pass', 'bounce', 'good', { note: 'Timing reads well now; the squash can wait for the next pass.', by: me })
R.setVerdict('motion-pass', 'orbit', 'wrong', { note: 'There is a visible hitch where the loop restarts.', by: me })
it({ key: 'ui-sounds', title: 'Interface sound pass', kind: 'review', status: 'review', repos: 'web-app', body: 'Generated placeholder sounds. Listen, read the waveform, check the licence line.' })
R.addMedia('ui-sounds', 'click', tone('click', 'sin(2*PI*t*900)*exp(-40*t)*0.7', 0.15), { slot: 'audio', label: 'button click', title: 'Click', licence: 'CC0 (generated)', source: 'generated with ffmpeg aevalsrc', by: 'nightly' })
R.addMedia('ui-sounds', 'confirm', tone('confirm', 'sin(2*PI*t*(520+260*gt(t,0.12)))*exp(-5*t)*0.6', 0.45), { slot: 'audio', label: 'confirm chime', title: 'Confirm', licence: 'CC0 (generated)', source: 'generated with ffmpeg aevalsrc', by: 'nightly' })
R.addMedia('ui-sounds', 'error', tone('error', 'sin(2*PI*t*(170+40*sin(2*PI*t*9)))*exp(-3*t)*0.6', 0.5), { slot: 'audio', label: 'error buzz', title: 'Error', licence: 'CC0 (generated)', source: 'generated with ffmpeg aevalsrc', by: 'nightly' })
R.setVerdict('ui-sounds', 'click', 'good', { note: '', by: me })
R.setVerdict('ui-sounds', 'error', 'wrong', { note: 'Too long and too harsh next to the others; trim to 0.3 s.', by: me })
console.log('seeded', S.DB_PATH)
