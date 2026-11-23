# Panel reference

Details behind the README: sign-in, layout, attachments, 3D pins, games, QA, reviews, lists, charts, the RSI board, lines of code, the data model and the source layout.

## Running the panel

```bash
npm run dev            # http://0.0.0.0:3010, hot reload  (or: ~/stack/dev.sh nightly)
npm run build && npm run start   # production on :3010
```

Sidebar groups: Transcripts, Projects, Tasks (Queue, In progress, Review, Blocked, Issues, Done), Automation (Workflows, Checks), Usage, Game Tools, Account and AdminCP; entries you may not use are hidden. Quick-add bar on every list (type a title, Enter; Ctrl+Enter adds and opens it; `c` focuses it, `/` focuses search). Hover a row to move it up/down/to the top. Item pages render the body as Markdown, edit every field in place, and hold a notes thread. AdminCP Settings has the `doRun` switch (pauses every schedule), the usage limits and an optional runner path.

- **Prompts:** every prompt and script, edited in place (Ctrl+S; unsaved text survives a reload; a save refuses to overwrite a newer one written by a run), with each version kept and restorable. A schedule names the prompt it starts with; the runner script is the one named `run.sh`.

- **Schedules:** each has a cron expression (local time; the next three fire times are shown as you type), a prompt (from Prompts), instructions appended for that schedule only (that is how a schedule gets a task of its own: "only the due checks", "only game-dev"), max turns, and whether it may overlap another run. **Run now** starts one immediately and ignores the pause switch.
- **Runs & reports:** every run, searchable across reports and logs; a run page shows its summary, the items it noted, the report, the runner's log (live while running, with **Stop**), and the screenshots filed under that day.
- **Agents:** live sessions with their task and claimed paths, a message feed (send to everyone or one agent), and controls to release a stale claim or end a session that vanished.

**Sign-in:** every page, the API and `/media` need a user. On first start the panel creates an `admin` user: from the old single-login settings if they were set, else from `NIGHTLY_ADMIN_USER` / `NIGHTLY_ADMIN_PASSWORD` in `.env`, else with a random password printed once to the server log. Sessions last 90 days; changing a password or disabling a user signs them out everywhere. Manage people under AdminCP → Users and Roles, or from a shell: `nightly user add NAME --roles user --password-stdin`, `nightly user set NAME --password-stdin` (also the way back in when locked out), `nightly role ...`. Scripts that post reports (perf, assets, usage, QA) send a Bearer token. Behind anything but your own network, put the panel behind HTTPS too.

**Layout:** the sidebar groups Transcripts, Projects, Tasks, Automation, Usage, Game Tools, Account and AdminCP, and only shows what your permissions allow. Old links (`/queue`, `/games/...`, `/settings` ...) redirect to their new place. Projects live in folders; each project page has its own tabs, and its icon is uploaded under its Settings tab (PNG, JPEG, GIF or WebP, up to 512 KB).

**Item attachments.** `nightly attach <item> <file.png|jpg> [--note ..]` downscales to 1280 px wide, keeps it under 2 MB (JPEG fallback), stores it in `NIGHTLY_ATTACH` (default `data/attachments/<item>/`, with an `index.json`) and keeps the last 20 per item. The item page shows thumbnails (click to enlarge) with notes, `nightly show` lists the URLs (`NIGHTLY_PUBLIC_URL`, default `http://<hostname>:3010`), served at `/attachments/<item>/<file>`. From another machine: copy the image to a temp path and run `ssh <host> nightly attach ...`, which is what a wrapper script does.

**3D models and pinned notes.** A `.glb`/`.gltf` stored next to a picture with the same base name (`shot.png` and `shot.glb`) is that picture's model; `nightly attach shot.png` copies a sibling model beside it, and it is pruned with the picture. Clicking such a picture (Screenshots, an item page, a game page) opens an orbit viewer (three.js, bundled, exact-pinned) with a 3D / Picture switch. Clicking the surface asks for a note and stores a pin (point, normal) in the `Annotation` table; clicking a flat picture stores x, y as fractions of its size. Routes: `GET /api/annotations?item=&target=`, `POST` (`item, target, kind: model|image, x, y, z, nx, ny, nz, text, author`), `DELETE ?id=`. Review media does not carry models.

**Games** (`/game`, `/game/<slug>`): items, runs, pictures, reviews and QA per game. The game is taken from an item's repos: the first `game-*`/`mg-*` repo, else a `<x>-maps` repo of that game, else the aliases in `src/lib/games.ts`; everything else is under `other`.

**QA** (`/qa`): game machines push fuzz / visual / suite results with `scripts/qa-post.sh <kind> <game> <file>` (POST `/api/qa`, schema on the page; table `QaRun`, images under `NIGHTLY_ATTACH/qa-<id>/`). Same optional password as the panel; the poster logs in with `QA_USER`/`QA_PASSWORD`. Panel-only table, the CLI does not read it.

**Reviews** (`/reviews`, kind `review`): per-weapon animation filmstrips and looping clips (before/after) and audio with waveform and licence line, each weapon with a verdict (good / still wrong) and a note. Files live under `data/reviews/<key>/<weapon>/` (`NIGHTLY_REVIEWS`) with a `review.json`; no database table. Builders file with `scripts/review-post.sh new KEY "Title"`, then `media KEY WEAPON FILE --slot filmstrip|clip|audio|image [--variant before|after] [--label L] [--title T] [--licence L] [--source URL] [--waveform W.png]` (same `QA_URL`/`QA_USER`/`QA_PASSWORD` as `qa-post.sh`; audio gets a waveform drawn for it if none is given; the same slot, variant and label replaces). You set the verdicts on the page. Builders read them back with `scripts/review-post.sh open KEY` (weapons not yet good, with notes) or, on the machine that runs the panel, `nightly review open|show|list KEY`; fix the weapons marked wrong, re-post the media as `after`, and the verdict history is kept.

**Perf budget** (`/qa`, kind `perf`): the `Perf budget` schedule (03:30) has the job script `perf-budget.sh` (kind `script`, first line a shebang). `run.sh` runs a prompt like that as a job, not a Claude run (no plan-usage gate, no agent): it routes through the work user's `hv` wrapper (heavy queue, GPU boxes), runs the game repository's `tools/perf_budget.sh --post` (frame-time percentiles, worst stall, load time, peak RSS and pack size per map on the GPU box, against a committed baseline) and the run is ok or failed by the exit code. The script posts through `scripts/qa-post.sh perf`; the page draws a trend chart per metric and map (last 30 runs, baseline and budget dashed, over-budget runs red). Any other job is a new prompt with a shebang plus a schedule.

**Screenshots** are read from `NIGHTLY_MEDIA` (default `archive/screenshots`, laid out `<YYYY-MM-DD>/…`) and served at `/media/…`; a report's `![](screenshots/<date>/x.png)` renders inline.

**Opening the dev panel from another machine:** set `NIGHTLY_DEV_ORIGINS` to the hostname(s) you use (see `.env.example`), or `npm run dev` serves the page and never hydrates.

**Service:** the panel is also the scheduler, so it should keep running. [`deploy/nightly-panel.service`](deploy/nightly-panel.service) is a systemd user unit that runs the production build, restarts it if it stops, and starts it at boot.

```bash
# Set WorkingDirectory (your clone) and the npm path in the unit first.
# Build the panel, then install and start the unit.
npm run build
cp deploy/nightly-panel.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now nightly-panel

# Keep it running when you are not logged in.
loginctl enable-linger $USER
```


## Reviews
Reviews are for judging animation, model and sound work, where a green test says nothing about whether it looks or sounds right. A builder files a review item and posts media under one entry per weapon, character or sound:

| Kind | What it shows |
| --- | --- |
| Clip | A looping before and after video with a slider, A/B and side-by-side views, frame stepping, speed control, a timing strip from the clip, and a before/after metrics table. |
| Filmstrip | A timing strip of frames, before and after. |
| Image / screenshot | A picture, before and after, in a viewer with zoom, pan and native size. |
| Audio | A player, a waveform and a licence and source line. |

Each entry carries what to look for, a verdict (Good or Still wrong) with a note, and the verdict history. Builders read the notes back with `scripts/review-post.sh open KEY` (or `nightly review open KEY` on the panel's machine), fix what is marked wrong and re-post the media as `after`. Files are stored under `NIGHTLY_REVIEWS` with a `review.json`; there is no database table. Filing and reading are described under [Panel](#panel).

## Lists and paging
Every long list is server-side paged through the shared `DataTable` and `ListControls` components: the page, size, sort, search and filters live in URL params (one namespace per table, so two tables can share a page), and the server turns them into limit, offset, order and where. Phase 2 moved the Performance run list (search commit, label, map; sort by run, time, scope or commit; tick two runs to compare) and the Prompts and Jobs sidebar (search name or text; sort by name or last saved) onto that path. The health feeds, performance findings and RSI tables were already converted. The query building for the run list and the prompt list is pure code in `lib/list-query.mjs`, covered by `lib/list-query.test.mjs` (run `npm test`). The Tokens table and the games overview cards are paged the same way (`perf.tokens`, `perf.gamesPage`, built by `pageList` in `lib/list-query.mjs`).


## Lines of code

Every project shows its code, comment and blank lines, total and file count; every folder shows the sum of everything inside it, recursively. Counting is done by [`scc`](https://github.com/boyter/scc) with the same exclusions as the owner's `loc.sh` (directories `node_modules`, `vendor`, `.godot`, `.git`; files matching `.min.` or `package-lock`; see `lib/loc-core.mjs`).

- **CLI**: `nightly loc [PROJECT | --all] [--folder F] [--force] [--no-ch] [--json]` scans the project's `repoPath`, prints the numbers and caches them. A project is rescanned only when its git HEAD changed (or with `--force`); uncommitted edits are not noticed without `--force`. A project with no `repoPath` is skipped, a missing path is reported as an error for that project.
- **Finding scc**: setting `sccPath`, then env `NIGHTLY_SCC`, then `scc` on PATH, then `~/bin/scc` and `/usr/local/bin/scc`. If none exists the command fails with the list of places tried; a missing counter never records zeros.
- **Cache**: SQLite table `LocStat` (one row per scan, the newest per project is the cache; created by the additive schema sync like any Prisma table). Only the CLI writes it; the panel reads it through Prisma and starts a rescan by running `nightly loc` (editors only, `projects.edit`).
- **History**: ClickHouse table `loc_history` (`ts, project, folder_path, type, code, comments, blanks, total, files, sha`), one row per project per scan and per folder roll-up, plus a daily snapshot when the sha has not changed. The table is created by the same startup bootstrap as the usage tables (`deploy/clickhouse/schema.sql`), on fresh and existing databases alike. If ClickHouse is off or unreachable the feature still works from the SQLite cache and the CLI logs the miss; the project-page sparkline reads the SQLite rows, so it needs no ClickHouse.
- **Schedule**: `nightly tick` refreshes changed projects every `locRefreshHours` (default 24, `0` = only by hand).
- **Panel**: LOC chips on the /projects cards, totals beside folders in the tree, a "Sort: lines of code" option, and a Lines of code block on the project overview (totals, language bars, history sparkline, Rescan). Numbers are compact (1.2k, 3.4M) with the exact value in the tooltip.


## RSI board and audit output
`nightly rsi refresh` (every `rsiRefreshHours` from `tick`) runs `rsi_asset_audit.py` per texture tier, then audits maps from `perf_bench --mesh-census` logs (`rsiCensusDir`; budgets `rsiMeshBudget`, `rsiAlphaBoxBudget`). The audit tool is looked up in this order: setting `rsiAuditScript`, env `NIGHTLY_RSI_AUDIT`, dot-game `tools/rsi_asset_audit.py` on its checked-out branch (main once merged), then read from the `nightly/rsi-assets-audit` branch; if none exist a `NO_AUDIT_TOOL` finding is raised. Output goes to `data/rsi-assets` inside the checkout (core-owned); the setting `rsiAuditDir` or env `NIGHTLY_ASSETS_DIR` overrides it (the panel only follows the env var). Tests: `npm test`.


## Charts on every tab

Each tab opens with charts built from one small shared kit (`src/components/Charts.tsx`, helpers in `lib/charts.mjs`, tested with `npm test`; no chart library). Every mark has a tooltip and an `aria-label`, bar and cell rows move with the arrow keys, clicks go to the run, card or filter behind the mark, and an empty tab says so instead of drawing an empty frame. The palette (red, blue, amber, green on the dark surface) passed the dataviz validator; outcomes always use the same colour: ok green, findings amber, failed red, running blue, skipped grey.

| Tab | Charts |
| --- | --- |
| Runs & reports | runs by day stacked by outcome (click opens that day's newest run), completion, cost and median-time tiles, duration and cost sparklines, weekday-by-hour start heatmap |
| Schedules | next 72 hours of starts, success-rate sparkline and status strip per schedule |
| QA | pass and fail per day, health heatmap per game and kind |
| Assets | score distribution (click filters the table), pass share by pack and kind, most common flags, worst offenders |
| Reviews | verdict donut (click filters), progress per review, verdicts given per day |
| Settings and Home | item counts, runs by day, completion and cost |



## RSI board (home page)

The home page (`/`) is the RSI board: one card per domain (perf, models, textures, animations, sounds, maps) with found, fixed and remeasured counts and the average before/after change, a list of the worst-scoring assets first (each links to `/assets/<id>`), a blockers panel, and the findings per domain. Every finding shows its next action.

- **Auto audit and ingest**: the tick runs `nightly rsi refresh` on a schedule (`rsiRefreshHours`, default 6; `rsiAuditScript` overrides the audit script path). It runs the asset audit once per video-settings tier, ingests the result (no manual `nightly assets ingest`), creates or updates one finding per failing flag, closes it as remeasured when the flag clears (keeping the before and after scores) and opens a fix item per pack. `nightly rsi board` prints the counts, `nightly rsi sync` re-runs only the finding and blocker pass.
- **Video-settings tiers**: texture findings are judged against the low, medium and high tiers (`rsiTiers`); the board has a tier switch (`/?tier=low|medium|high`). Bolt-action cycle-clip flags show under Animations when the audit emits them.
- **Blocker minimization**: the blocker pass flags duplicate, stale (`rsiStaleDays`, default 30) and blocked items and any item parked "waiting on owner", with the reason and the next action. Stale and duplicate agent items are closed automatically with a note; only the production website deploy may wait on the owner.


## Data model

`Item` (key, title, body markdown, kind, status, priority, repos, doneWhen, addedBy, cadence, lastRunAt, completedAt), `Note` (item, optional run, author, body), `Run` (startedAt, finishedAt, status, summary, report, log, turns, minutes, costUsd, trigger, pid, schedule), `Schedule` (name, cron, enabled, prompt, instructions, maxTurns, allowOverlap, lastFiredAt), `Agent` (name, kind, task, repos, run, lastSeenAt, endedAt), `Claim` (agent, scope, note, releasedAt), `Message` (author, to, body), `Prompt` (name, kind prompt|script, body) with `PromptVersion` (every saved body), `Setting` (key/value; `doRun`, `runner`, usage limits). See `prisma/schema.prisma`.

## Layout

```
bin/nightly, bin/nightly.mjs   CLI
lib/store.mjs                  CLI/import data layer (node:sqlite)
lib/runner.mjs                 tick / start / exec / stop
lib/agents.mjs                 the agent board (join, claim, messages)
lib/prompts.mjs                prompts and the runner script, versioned
lib/cron.mjs (+ .d.mts)        cron expressions, shared with the panel
lib/env.mjs                    loads .env for the CLI
src/instrumentation.ts         starts the built-in scheduler with the panel
prisma/schema.prisma           schema
scripts/import-markdown.ts     one-off importer (to-do list)
scripts/import-history.ts      one-off importer (report files, runner logs)
scripts/import-prompts.ts      one-off importer (prompt files, runner script)
scripts/run.sh                 the runner a schedule starts
scripts/claude-usage.sh        Claude plan usage (5-hour and weekly)
src/server/api.ts              tRPC router (items, notes, runs, schedules, prompts, agents, settings)
src/app/media/[...path]        screenshots
src/components/                list, item detail, runs, schedules, prompts, agents, settings UI
src/proxy.ts                   optional password
data/nightly.db                the database (gitignored)
```

