This started out as a small project I had [Claude Code](https://claude.com/product/claude-code) create for my internal development with my gaming and modding project, [**GameSpice**](https://gamespice.net).

Initially, one simple cron job ran *every night* to manage tasks and track the progress of Claude Code agents and workers. Over time, I've been adding more and more features to the project. Given these additions, I've been impressed with how much functionality has been getting integrated into the project and I decided I'd make it open source so that others can benefit from it if they want to use it for their development.

Companion repo: the scripts, systemd units, offload helpers and agent instruction files that run my own fleet on top of nightly are public in [nightly-env](https://github.com/gamemann/nightly-env).

## What RSI means here

RSI is recursive self-improvement, the loop nightly is built around: **find, fix, remeasure**. An audit or benchmark finds a problem (a model with too many triangles, a texture over budget, a frame-time regression, a failing visual check) and records it as a *finding*. A fix item goes into the queue and an agent works it. When the next audit runs and the flag has cleared, the finding closes as *remeasured*, keeping its before and after scores, so every fix is checked by a measurement instead of an opinion. The RSI board on the home page counts findings per domain (perf, models, textures, animations, sounds, maps) in those three states, lists the worst assets first and shows what is blocking progress. See [RSI board](#rsi-board) and [RSI board and audit output](#rsi-board-and-audit-output) for the commands and settings.

The screenshots below are the live panel at 1280px with real numbers; host names, paths and addresses are scrubbed, and the pages that show private task text are left out.

![RSI board: findings by state and domain, runs by day](./docs/panel-rsi-board.png)
*RSI board: findings by state and domain, with the runs-by-day chart above.*

![Reviews: verdicts, progress per review, server-paged list](./docs/panel-reviews.png)
*Reviews: verdict totals, progress per review and a searchable, sortable, paged list.*

![QA: pass and fail by day, health by area, per-card budgets](./docs/panel-qa.png)
*QA: pass and fail per day, a health grid per game and kind, and the over-budget metrics of the newest perf run.*

![Schedules: next runs timeline and success per schedule](./docs/panel-schedules.png)
*Schedules: upcoming starts, success per schedule and the paged schedule list.*

![Assets: score distribution and pass share by pack and kind](./docs/panel-assets.png)
*Assets: score distribution, pass share by pack and kind, and the most common quality flags.*

![Performance: games with budgets and findings](./docs/panel-perf.png)
*Performance: per-game budgets, regressions and the findings table.*

![Queue](./images/preview01.png)
*Queue: prioritised to-dos with status lists and per-game sections.*

![Review clip with before/after slider](./images/preview22.png)
*Reviews, the standout: a before/after animation clip with a slider, frame stepping, timing strip, metrics and Good / Still wrong controls.*

<details>
<summary>View more images</summary>

![In progress](./images/preview02.png)
*In progress: what agents are working on right now.*

![Item detail](./images/preview03.png)
*Item detail: body, notes and attachments.*

![Review](./images/preview04.png)
*Review: work waiting for a verdict.*

![Checks](./images/preview05.png)
*Checks: recurring checks that run when due.*

![Done](./images/preview06.png)
*Done: finished items.*

![Blocked](./images/preview07.png)
*Blocked: items waiting on something.*

![Issues](./images/preview08.png)
*Issues: problems filed by agents or schedules.*

![Agents](./images/preview09.png)
*Agents: the live board of concurrent agents and their messages.*

![Runs and reports](./images/preview10.png)
*Runs and reports: history of every run.*

![Run report](./images/preview11.png)
*Run report: the full report a run writes.*

![Schedules](./images/preview12.png)
*Schedules: cron schedules with a master switch and Run now.*

![Prompts](./images/preview13.png)
*Prompts: the instructions every agent reads.*

![Prompt editor](./images/preview14.png)
*Prompt editor: edit a prompt in the panel.*

![QA](./images/preview15.png)
*QA: newest run per game and kind, with the recent pass/fail trend and how to post results.*

![Reviews](./images/preview16.png)
*Reviews: every review item with its counts of not reviewed, good and still wrong, plus how to file one.*

![Review side by side](./images/preview23.png)
*Review, side by side: before and after clips play in step, with frame stepping and 1x / 0.5x / 0.25x speed.*

![Review still wrong](./images/preview24.png)
*Review, still wrong: a verdict with the note a builder reads back, and the verdict history kept.*

![Review audio](./images/preview25.png)
*Review, audio: a player, a waveform, the licence and source line, and a verdict per sound.*

![Review filmstrip](./images/preview26.png)
*Review, picture entry: before and after screenshots with a verdict and note.*

![Review viewer](./images/preview27.png)
*Review viewer: zoom and pan any review picture at native size, with arrows to step through the entry's media.*

![Screenshots](./images/preview17.png)
*Screenshots: media attached by agents.*

![Games](./images/preview18.png)
*Games: per-game overview.*

![Game page](./images/preview19.png)
*Game page: items for one game.*

![Settings](./images/preview20.png)
*Settings: runner, usage thresholds and login.*

![Login](./images/preview21.png)
*Login: optional password protection.*

</details>

The screenshots use demo data generated by `scripts/seed-demo.mjs` (run it against an empty throwaway database; see the header of the script).


Stack: Next.js 16 (App Router) · tRPC v11 · Prisma 7 (SQLite via `@prisma/adapter-better-sqlite3`) · Tailwind v4 · React 19. The CLI is plain Node ESM on `node:sqlite`.

## Features
Everything below is in the web panel and in the CLI (`bin/nightly`); the panel talks to the same database.

- **Queue and items.** An item is a task, issue, check, study or review with a body written as Markdown, repos, a checkable "done when", priority and a notes thread. Lists are ordered; priority is per list, lower first, and quick-add takes a title and Enter. Items are never deleted, they are closed as done or won't fix.
- **In progress.** What an agent has started. An item that cannot be finished in one go sits here with a note saying exactly where it stopped, so the next agent can pick it up cold.
- **Review.** Work waiting for a human verdict. Agents move finished items here, you read the notes and either close them or send them back to the queue.
- **Checks.** Standing checks with a cadence (nightly, every 2 days, weekly, monthly). A check is due when it has not been run for its cadence, and a run goes through the due ones and records each with `nightly checked`.
- **Blocked.** Items waiting on something outside the run, with the reason in the notes, so they stop being picked up.
- **Issues.** Problems found by agents or schedules, filed as items of kind issue and worked like any other.
- **Done.** Finished and won't-fix items with their completion time and full note history.
- **Agents and the live board.** Every concurrent agent joins the board with its task, claims the paths it is changing, and talks to the others through messages. A claim that overlaps a live agent's is refused, which stops two agents editing the same files. Stale agents stop blocking after a while and stale claims can be released from the panel.
- **Runs and reports.** Each run records its status, summary, turns, duration, cost, runner log (live while it runs, with Stop) and the full report the agent writes, searchable across all runs.
- **Schedules and the scheduler.** Cron schedules with a prompt, extra instructions for just that schedule, max turns and an overlap switch, plus a master switch and Run now. The panel's scheduler checks every minute; a crontab line works too, and two schedulers never fire the same schedule twice.
- **Prompts.** The instructions every agent reads and the runner script itself live in the database, edited in the panel with every version kept and restorable.
- **QA runs.** Game machines push fuzz, visual, suite and performance results; the QA page shows the newest run per game and kind with a pass/fail trend and the frame-time budget charts.
- **Reviews.** See below.
- **Screenshots.** Pictures agents attach to items or file under a day appear in a gallery, open in a zoomable viewer, and a `.glb` next to a picture opens an orbit 3D viewer where you can pin notes.
- **Games.** Items, runs, pictures, reviews and QA are grouped per game, taken from the repos an item names.
- **Usage limits and multiple accounts.** A script reads your Claude plan's 5-hour and weekly usage. Set thresholds in Settings and the runner will not start while usage is over them. With several Claude accounts configured, each run picks the one with the most headroom.
- **Login.** Optional password (and username) protection for every page, the API and media, off by default.
- **CLI.** All of the above from a shell, without the panel or a server running: see [CLI](#cli).

### Reviews
Reviews are for judging animation, model and sound work, where a green test says nothing about whether it looks or sounds right. A builder files a review item and posts media under one entry per weapon, character or sound:

| Kind | What it shows |
| --- | --- |
| Clip | A looping before and after video with a slider, A/B and side-by-side views, frame stepping, speed control, a timing strip from the clip, and a before/after metrics table. |
| Filmstrip | A timing strip of frames, before and after. |
| Image / screenshot | A picture, before and after, in a viewer with zoom, pan and native size. |
| Audio | A player, a waveform and a licence and source line. |

Each entry carries what to look for, a verdict (Good or Still wrong) with a note, and the verdict history. Builders read the notes back with `scripts/review-post.sh open KEY` (or `nightly review open KEY` on the panel's machine), fix what is marked wrong and re-post the media as `after`. Files are stored under `NIGHTLY_REVIEWS` with a `review.json`; there is no database table. Filing and reading are described under [Panel](#panel).

### Lists and paging
Every long list is server-side paged through the shared `DataTable` and `ListControls` components: the page, size, sort, search and filters live in URL params (one namespace per table, so two tables can share a page), and the server turns them into limit, offset, order and where. Phase 2 moved the Performance run list (search commit, label, map; sort by run, time, scope or commit; tick two runs to compare) and the Prompts and Jobs sidebar (search name or text; sort by name or last saved) onto that path. The health feeds, performance findings and RSI tables were already converted. The query building for the run list and the prompt list is pure code in `lib/list-query.mjs`, covered by `lib/list-query.test.mjs` (run `npm test`). The Tokens table and the games overview cards are paged the same way (`perf.tokens`, `perf.gamesPage`, built by `pageList` in `lib/list-query.mjs`).

### Companion repo
[nightly-env](https://github.com/gamemann/nightly-env) holds the pieces that run my fleet on top of nightly: the scripts, systemd units, offload helpers and agent instruction files. nightly stays generic; nightly-env is one concrete setup.

## Setup
Please refer to the following commands for initially setting up the project. You can use `git` to clone this repository.

```bash
# Clone repository and change to its directory.
git clone https://github.com/gamemann/nightly

cd nightly

# Installs the main application and generates the Prisma client.
# Sets up the database and imports initial data.
npm install

# Run database setup and import initial data.
# Creates data/nightly.db from prisma/schema.prisma
npm run db:push
```

A new database is blank and paused. In the panel: add a runner script named [`run.sh`](./scripts/run.sh) and a prompt (Prompts), a schedule (Schedules), then switch **Nightly run** on (Settings). The repository includes a runner you can start from; see [Runner Script](#runner-script) below.

### Restarting the panel
After a deploy (`git merge --ff-only`, `npx prisma generate`, `npm run build`) run [`scripts/restart-panel.sh`](./scripts/restart-panel.sh). Where there is no systemd unit the panel is plain `npm start` on port 3010; the script stops whatever listens there and starts a fresh detached `npm start`, logging to `data/panel.log` (`--stop` only stops it). It re-runs itself as the checkout's owner, and runs already started keep going.

### Usage tab

`/usage` shows where your Claude Code tokens go, read from the transcript files Claude Code keeps on disk. Totals (today, 7d, 30d, all), a stacked chart over time (by token kind or by model, daily or hourly, with a table view), sortable breakdowns with share bars (project, session, agent type, model, tool, skill or prompt, branch), drill-down from any row to its sessions, and a "Where it goes" panel whose every finding comes with a concrete suggestion: cache-read versus fresh input, biggest tool results, files re-read, polling loops, idle agents, long thinking, subagent fan-out, compactions, oversized context, model mix.

![Usage tab](docs/usage-tab.png)

The screenshot is synthetic data (`scripts/usage-demo-seed.mjs`).

- **Works without ClickHouse.** `nightly usage ingest` fills local SQLite tables and the tab reads them, so it is useful on day one. ClickHouse is an optional mirror for big histories: the tab prefers it while it answers and falls back to the local copy (with a notice) when it does not.
- **Ingest** is incremental (a per-file byte offset and mtime table; only whole lines are read) and dedupes by message id, last write wins, so a message repeated once per content block counts once. Subagent sidechain files are included and attributed to their agent type. Run it from the tab (Ingest now), `nightly usage ingest [--full] [--dir D]`, `curl -X POST "$PANEL/api/usage/ingest"` (panel session, or `Authorization: Bearer $NIGHTLY_USAGE_TOKEN`), or let the scheduler do it: setting `usageAutoIngestMinutes` (0 = off).
- **CLI**: `nightly usage ingest|summary|top <dim>|cost|insights|status|ch-setup`, all with `--json`.
- **ClickHouse**: `docker compose up -d clickhouse` (pinned official image, named volume, healthcheck, bound to 127.0.0.1 by default; credentials come from `.env`, see `.env.example`; `deploy/clickhouse/schema.sql` creates the database and `ReplacingMergeTree` tables on first start). Then set `usageChEnabled=true` (and `usageChUrl`, `usageChDb`, `usageChUser`) in Settings or the tab's settings box; the password is read from the environment variable named by `usageChPasswordEnv` (default `NIGHTLY_CLICKHOUSE_PASSWORD`) and is never stored or printed. Rows go over the HTTP interface in batches; a failed push never fails the ingest and stays queued for the next one. `usage ingest --resync` re-sends everything. Without Docker, a native ClickHouse server works the same: create the user named by `usageChUser` with that password and grant it ALL on the database (`CREATE USER ... IDENTIFIED BY ...; GRANT ALL ON nightly_usage.* TO ...`), then run `nightly usage ch-setup`. `npm test` also runs a live parity test (same numbers from ClickHouse and sqlite) when a server answers; it uses a scratch database it drops, so the user also needs `GRANT ALL ON nightly_usage_test_*.*`, and skips otherwise.
- **Settings** (database, editable in the tab): `usageDirs` (comma or newline list, default `~/.claude/projects`, env `NIGHTLY_USAGE_DIRS`), `usageProjectMode` (`basename` | `hash` | `none`: how the project label is derived from the working directory), `usageAutoIngestMinutes`, `usagePollMin` (a repeated wait-and-check call within this many minutes counts as polling, default 8), `usageBigResultTokens` (default 8000), `usagePrices`.
- **Prices are estimates.** `usagePrices` is a JSON table of USD per million tokens by model-name substring (`*` is the fallback), edited in the tab. The defaults are generic placeholders; set your own. Dollar figures are not a bill. Tool-result sizes are estimated from text length (about 3.5 characters per token, a flat 1200 per image).
- **Privacy**: only counts, ids, tool names, model, branch and the project label are stored. No message, prompt, file or tool-result text is kept; with `usageProjectMode=none` not even the project name. Nightly's own scheduled runs (turns, minutes, recorded cost) are listed next to the transcript data.
- **Tables** (`usage_*`) are created by `nightly usage ingest`, outside the Prisma schema, so `prisma db push` does not manage them.

## RSI board and audit output
`nightly rsi refresh` (every `rsiRefreshHours` from `tick`) runs `rsi_asset_audit.py` per texture tier, then audits maps from `perf_bench --mesh-census` logs (`rsiCensusDir`; budgets `rsiMeshBudget`, `rsiAlphaBoxBudget`). The audit tool is looked up in this order: setting `rsiAuditScript`, env `NIGHTLY_RSI_AUDIT`, dot-game `tools/rsi_asset_audit.py` on its checked-out branch (main once merged), then read from the `nightly/rsi-assets-audit` branch; if none exist a `NO_AUDIT_TOOL` finding is raised. Output goes to `data/rsi-assets` inside the checkout (core-owned); the setting `rsiAuditDir` or env `NIGHTLY_ASSETS_DIR` overrides it (the panel only follows the env var). Tests: `npm test`.

### Scheduler
There is no cron job to set up. While the web panel is running, it checks every minute whether one of your schedules is due and starts it. The schedules themselves (when, which prompt, any extra instructions) are managed in the panel, and the **Schedules** page shows when the scheduler last checked in, with a warning if it has stopped.

Runs only start while the panel is up, so keep it running: the included systemd unit does that and starts it again after a reboot (see [Panel](#panel)). A run that has started keeps going if the panel is restarted.

If you would rather not depend on the panel being up, a crontab line does the same job, alongside the panel or instead of it. Two schedulers never start the same schedule twice.

```bash
# Optional: open your user's crontab.
crontab -e

# Add this line, using the path you cloned the repository to.
# tick.log only gets a line when a schedule fires or something breaks.
* * * * * /path/to/nightly/bin/nightly tick >> /path/to/nightly/data/tick.log 2>&1

# To use only the crontab, turn the panel's scheduler off in .env:
# NIGHTLY_SCHEDULER=off
```

### Runner Script
The runner is the shell script each run executes. It decides whether it is safe to run and which repositories to leave alone, then starts Claude Code with your prompt. [`scripts/run.sh`](scripts/run.sh) is a complete one:

- Skips the run when your Claude plan usage is past the limits set in **Settings → Usage limits** (using the usage check below).
- Finds every Git repository in your workspace. A repository with uncommitted changes is handed to the agent to commit first, unless one of those files changed in the last 90 minutes; then somebody is mid-edit, and the agent is told to stay out of it.
- Adds the run's id, the agent board instructions and the schedule's own instructions to the prompt, then runs `claude -p` unattended.
- Sends Claude's final message, turn count, duration and cost back to the run in the web panel.

You can either store it in the database, which lets you edit it from the web panel (with history), or run the file in place.

```bash
# Store the included runner in the database (Prompts -> run.sh in the web panel).
bin/nightly prompt set run.sh --file scripts/run.sh

# Or run scripts/run.sh in place instead; edits then happen in the file.
bin/nightly set-setting runner scripts/run.sh
```

Nothing in the runner is specific to one machine. It is configured with environment variables, which you can put in `.env` (copy [`.env.example`](.env.example)); the CLI loads that file, so they also apply under cron.

| Variable | Default | What it does |
| --- | --- | --- |
| `NIGHTLY_WORKSPACE` | the parent of this repository | The directory of Git repositories the runs work in. |
| `NIGHTLY_REQUIRED_TOOLS` | `git node npm` | Commands to warn about in the run's log when missing. |
| `NIGHTLY_IDLE_MINUTES` | `90` | A repository with uncommitted files edited this recently is left alone. |
| `NIGHTLY_REPO_DEPTH` | `3` | How deep under the workspace to look for repositories. |
| `NIGHTLY_USAGE_SCRIPT` | `scripts/claude-usage.sh` | The usage check; `off` disables it. |
| `NIGHTLY_SCOPE_HOOK` | none | An executable whose output is added to every run's prompt, for checks of your own. |
| `NIGHTLY_CLAUDE_BIN` | `claude` | The Claude Code binary. |
| `NIGHTLY_CLAUDE_ARGS` | none | Extra arguments for `claude -p`, e.g. `--model claude-opus-5-5`. |
| `NIGHTLY_OFFLOAD_HOST` | none | Optional machine the runner touches over ssh before and after a run; unset means no ssh call. |
| `NIGHTLY_OWNER` | `owner` | Your name on the board: the author of notes and messages written in the panel, the default `--by`. Set it in `.env` before `npm run build` (the browser bundle inlines it). Rows written under another name stay as they are. |
| `NIGHTLY_USAGE_HOSTS` | none | Comma list of other machines `scripts/agent-usage.py` also scans over ssh. |
| `DOCS_CLAIMS_DIR` | `~/docs-site` | The docs site checkout `bin/docs-claims` reads. |
| `DOCS_CLAIMS_REMOTE_PREFIX`, `DOCS_CLAIMS_REMOTE_HOST` | none | A `source:` prefix (e.g. `box:`) whose files live on another machine, and the ssh host to ask for their last commit time. |
| `HEAVY_SSH_KEY`, `HEAVY_BUDGETS` | `~/.ssh/id_ed25519`, `~/.config/heavy/budgets` | `scripts/heavy/install.sh --remote` key, and the per-host memory budgets file (see `scripts/heavy/README.md`). |
| `NIGHTLY_OFFLOAD_KEY` | none | Optional ssh identity file for that machine. |
| `NIGHTLY_SKIP_PERMISSIONS` | `1` | `0` runs Claude without `--dangerously-skip-permissions`. An unattended run cannot answer permission prompts, so only do this with permissions allowed in your Claude Code settings. |

> [!WARNING]
> By default the runner starts Claude Code with `--dangerously-skip-permissions`, so the agent can run any command as your user in the workspace. Only point it at repositories you are comfortable letting an agent change, on a machine you are comfortable letting it use.

### Usage Check
[`scripts/claude-usage.sh`](scripts/claude-usage.sh) reads your Claude plan's current **5-hour** and **weekly** usage. The runner calls it before each run (and the agent between items), and it can be used on its own. Each call costs one tiny request against the 5-hour window.

```bash
# Show both windows with their reset times.
scripts/claude-usage.sh

# The same as JSON.
scripts/claude-usage.sh --json

# Exit 1 if the 5-hour window is at or over 80% or the weekly window at or over 90%.
# Exit 2 means the check itself could not read the usage; treat that as unknown, not as fine.
scripts/claude-usage.sh --check 80 90
```

Claude Code has no documented way to read plan usage outside its interactive `/usage` screen, so the script reads the rate-limit event `claude -p` reports before its answer, and falls back to looser parses if that format changes. When nothing usable comes back, it saves the raw output to `data/usage-probe-last.jsonl` (or `CLAUDE_USAGE_DEBUG_FILE`) for fixing the parse.

## Panel

```bash
npm run dev            # http://0.0.0.0:3010, hot reload  (or: ~/stack/dev.sh nightly)
npm run build && npm run start   # production on :3010
```

Sidebar: Queue · In progress · Review · Blocked · Issues · Checks · Done · Games · Agents · Runs & reports · Screenshots · QA · Reviews · Schedules · Prompts · Settings. Quick-add bar on every list (type a title, Enter; Ctrl+Enter adds and opens it; `c` focuses it, `/` focuses search). Hover a row to move it up/down/to the top. Item pages render the body as Markdown, edit every field in place, and hold a notes thread. Settings has the `doRun` switch (pauses every schedule), the usage limits and an optional runner path.

- **Prompts:** every prompt and script, edited in place (Ctrl+S; unsaved text survives a reload; a save refuses to overwrite a newer one written by a run), with each version kept and restorable. A schedule names the prompt it starts with; the runner script is the one named `run.sh`.

- **Schedules:** each has a cron expression (local time; the next three fire times are shown as you type), a prompt (from Prompts), instructions appended for that schedule only (that is how a schedule gets a task of its own: "only the due checks", "only game-dev"), max turns, and whether it may overlap another run. **Run now** starts one immediately and ignores the pause switch.
- **Runs & reports:** every run, searchable across reports and logs; a run page shows its summary, the items it noted, the report, the runner's log (live while running, with **Stop**), and the screenshots filed under that day.
- **Agents:** live sessions with their task and claimed paths, a message feed (send to everyone or one agent), and controls to release a stale claim or end a session that vanished.

**Login:** off by default. Settings → Login turns it on: a password (stored as a scrypt hash), optionally a username. Every page, the API and `/media` then need a sign-in (an HMAC-signed cookie, 90 days; changing the username or password signs every browser out; Sign out in Settings). Locked out: `bin/nightly set-setting authEnabled false` on the machine. Behind anything but your own network, put the panel behind HTTPS too.

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

## Jobs / Scripts

A prompt is text an agent is told; a **job** is a runnable script (kind `script`, name ends `.sh`, first line `#!`). `/prompts` lists prompts (with a markdown preview), `/jobs` lists jobs. A prompt whose body starts with `#!` shows a `script` badge. A schedule runs a job with no agent, and the Schedules page shows a `job` or `agent` badge per schedule.

- Exit code contract: `0` ok, `1` findings (the check ran and found problems: run status `findings`, amber, the gates open RSI findings), anything else `failed` (infrastructure or a broken script).
- The job page shows the last run of its schedules, the linked schedule(s), the contract and a **Run now** button (same as `nightly start <schedule>`).
- Host, repository path and command are the first lines of the script (`REPO=`, `CMD=`), so they are edited on the Jobs page, never baked into the panel. `nightly prompt rename <old> <new> [--kind script]` keeps the history and the schedules' links.

## Health feeds and gates

Generic, DB-driven pages, each with a CLI and a Bearer ingest (`POST /api/ingest/<kind>`, token from `nightly perf token add`): Releases (`/releases`, `nightly release`), Crashes (`/crashes`, `nightly crash`), Web checks (`/web`, bundle size, web vitals, uptime with budgets, `nightly web`), Playtests (`/playtests`, `nightly playtest`), Content (`/content`, `nightly content`). Failing checks raise RSI findings. The perf, visual and netchaos gates (`lib/gates.mjs`) open one RSI finding per failing check and close it when a later run passes; the finding says to re-baseline only if the change is intended.

## Agents liveness

`nightly agent join|heartbeat|leave` (or `POST /api/agents/heartbeat` with the ingest token) registers any runner. An agent is live for an hour after its last heartbeat, then stale, then left after the setting `agentLeftHours` (default 12). The Agents page lists a "Running (unregistered)" section from the setting `agentSourceCmd` (a command printing one agent per line) or `agentSourceFile`.

## Performance tab

`/perf` keeps benchmark runs and profiler reports per game: trend charts with budget lines and regression markers, a sortable profiler table (per function, budget group, addon), an icicle view of folded stacks, an A vs B comparison with a coloured delta table, top offenders, and findings linked to queue items.

![Performance tab](docs/perf-tab.png)

**Trends dashboard** (screenshots use synthetic data). Status cards (budgets, latest fps with delta, worst metric, regression count), a worst-offenders strip, one combined p50/p95/p99 frame-time chart with bands and budget lines, grouped collapsible sections, a metric-by-run regression heatmap, a distribution view and a compare-two-runs diff table. Every chart has a hover crosshair and tooltip (value, run, commit, map, bots, platform, change vs previous run and vs budget), a crosshair synced across charts, drag-to-zoom (Esc resets), legend toggles, log and 5-run-average toggles, arrow-key stepping and click-through to the run. Regression markers carry the reason. Data shaping lives in `lib/perf-chart.mjs` (tests: `npm test`); the reusable SVG components (`LineChart`, `Sparkline`, `BarList`, `Heatmap`, `Donut`) are exported from `src/components/PerfChart.tsx` and also used on the RSI board. Colours are the colour-blind-safe Okabe-Ito set.

![Trends before](docs/perf-trends-before.png)
![Trends after](docs/perf-trends-after.png)

- **Add a game** (no code change): `nightly perf game add --id fc --name "Fatal Contact" --repo fc-game --engine godot --platforms native,web --budget 'fps>=60@platform=native,role=client' --budget 'frame_ms_p95<=33@platform=web' --routing '{"native/client":{"host":"gpu-box","map":"arena","bots":4}}'`, or "Register a game" on `/perf`, or the `perf.addGame` tRPC mutation. `nightly perf game set|list|show` edit and inspect.
- **Ingest** a dot-profiler perf-report v1 (`gamespice.perf-report`), a legacy `profile-*.json`, a `.folded` stack file or a `.txt` report: `nightly perf ingest report.json --game fc [--platform web --role client --map arena --bots 4 --commit SHA]`. A v1 report may carry its stacks inline (`folded` string), or pass `--folded stacks.folded` (the icicle view and function table then work for v1 reports too); unknown fields, such as a coming v1.1 `baseline` section, are ignored. Over HTTP: `curl -X POST --data-binary @report.json 'http://panel/api/perf/ingest?game=fc&commit=SHA'` with the panel's auth or an ingest token (below); multipart parts `report` + `folded`, or a JSON `{report, folded}` envelope, upload stacks along with it.
- **Ingest tokens** for runners: `nightly perf token add --name runner-a [--game fc]` (or the Perf tab) prints a secret `nps_...` once; only a sha256 hash and an 8-character prefix are stored. A game-scoped token only ingests that game. Send it as `Authorization: Bearer nps_...`; the CLI reads it from the env var `NIGHTLY_PERF_TOKEN` (never argv). While no active token exists ingest stays open as before; once one does, ingest needs a token (or the panel session). `perfRequireToken=1` demands a token even with none issued. `perf token list|revoke NAME`. The raw files are kept under `data/perf/<game>/<stamp>/`.
- **Budgets** are evaluated on every ingest. A breach files a finding and one queue item keyed `perf-<game>-<metric>` (deduped; a still-open breach adds a note, a pass resolves the finding, a closed item gets a fresh one). `--no-findings` or setting `perfBreachItems=0` turns it off.
- **Regressions**: every ingest compares each watched metric with the median of the previous `perfRegressionRuns` (5) runs of the same game, platform, role, map and bots. It is a regression only past `max(perfRegressionNoisePct % of the median, perfRegressionSigma x 1.4826 x MAD)`, so jittery metrics need a bigger step, and not before `perfRegressionMinRuns` (3) runs exist. One item per game+metric+scope (`perf-<game>-regress-<metric>`), deduped. `perfRegression=0` turns it off.
- **Top offenders**: the top `perfOffenderTop` (3) functions by self time (engine and wait rows excluded) averaged over the last `perfOffenderRuns` runs and above `perfOffenderMinMs` (1 ms/frame) get one item per game+function (`perf-<game>-fn-<name>`), shown linked on the Offenders table. `perfOffenderItems=0` turns it off.
- **Findings and fixes (RSI)**: each finding goes found, then fixed when its item is done (before value kept), then remeasured by the next run of the same scope (after value and delta). A re-breach after that archives the cycle in the finding's history and files a new item; a `wontfix` item dismisses the finding for good. `nightly perf rsi [--game fc]` lists them, the Perf tab shows the same list.
- **Runner**: `nightly perf run --game fc [--dry-run]` runs each routing key (`native/client`, `web/client`, ...) through the game repo's `tools/perf.sh --platform P --role R [--map M] [--bots N] [--duration S] --out report.json` and ingests the result. A routing entry with a `host` runs over ssh; without one it runs locally. `nightly perf nightly` does this for every enabled game; `tick` starts it once a day after `perfNightlyAt` (default `03:40`, empty = off). Host names live in each game's routing JSON in the database, never in this repository. A routing entry with `"runAs":"gamedev"` instead runs perf.sh as that user through `sudo -n` on this box (the repo belongs to that user, no ssh). Budgets that name a `map` or `bots` different from the entry's defaults add one run each to `perf nightly` (`budgetRuns`), so a large-map budget is measured automatically.
- **Settings** (0 = unlimited, bad values fail loudly): `perfMaxArtifactBytes` (50000000), `perfMaxShotBytes`, `perfMaxShotsPerRun`, `perfRetentionDays`, `perfRetentionRuns`, `perfMaxFunctions` (0 = all), `perfBreachItems`, `perfNightlyAt`.
- **Setup and seed**: `nightly perf migrate` (idempotent; it writes a `backup/nightly-pre-perf-migrate-*.db` copy next to the database before touching anything), then optionally `node scripts/seed-perf.mjs <dir-of-profile-json>` to register games and import old profiles. Other commands: `perf runs|compare|findings|finding add`.
- **Gate in CI**: `nightly perf gate --game fc [--run ID|latest|COMMIT] [--platform P --role R --map M --bots N] [--no-budgets] [--no-baseline] [--noise-pct N] [--sigma N] [--min-runs N] [--metric M]...` checks one run against the game's budgets and against the previous comparable runs (same noise-aware rule as the regression check) and exits 0 pass, 1 fail, 2 no such run. A baseline with too few earlier runs is skipped, not failed. A suite or CI job ingests, then gates: `nightly perf ingest report.json --game fc --commit "$SHA" && nightly perf gate --game fc --run "$SHA"`. Without shell access use HTTP: `curl -s -H "Authorization: Bearer $NIGHTLY_PERF_TOKEN" "$NIGHTLY/api/perf/gate?game=fc&run=$SHA"` returns the verdict JSON with status 200 (pass), 422 (fail) or 404 (no run). Use `--require-token` or `--token-only` to demand a perf token on the CLI.
- **Visuals**: the game page charts p50/p95/p99 frame ms, fps, tick ms, draw calls, memory and net kbps over commits with budget lines. A run page shows a flame graph of its call trace (from the v2 `tree`, a `.folded` file or the profiler rows), a hitch timeline and its screenshots. `/perf/diff/<runA>/<runB>` is the differential flame graph (red = slower in B, green = faster, grey = inside the noise band) and each finding in the RSI tab links the run that found it to the run that measured the fix. Offenders carry a per-function history sparkline.
- **Screenshots**: `nightly perf shot add --run ID frame.png [--name N --note T]` (or `-` for stdin, or `POST /api/perf/shot?run=ID` with a png body and the same Bearer token) attaches a png to a run, for example the frame at the worst hitch. Limits: `perfMaxShotBytes` (5000000) and `perfMaxShotsPerRun` (30), 0 = unlimited.
- **Reports**: `nightly perf report ID [--out DIR] [--png] [--image-url URL]` writes `perf-run-ID.md` and `.svg` (and `.png`) for READMEs and PRs; the panel serves them at `/api/perf/report/ID?format=md|svg|png`. `nightly perf diff A B [--out DIR] [--png]` does the same for two runs.

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

Screenshots below come from a synthetic database (`python3 scripts/seed-demo.py <dir>`, run the panel with `NIGHTLY_DB=<dir>/nightly.db NIGHTLY_REVIEWS=<dir>/reviews NIGHTLY_SCHEDULER=off`); none of it is real data.

![Runs and reports](docs/charts-runs.png)
![Schedules](docs/charts-schedules.png)
![QA](docs/charts-qa.png)
![Assets](docs/charts-assets.png)
![Reviews](docs/charts-reviews.png)
![Settings](docs/charts-settings.png)
![Home](docs/charts-home.png)

## RSI board

The home page (`/`) is the RSI board: one card per domain (perf, models, textures, animations, sounds, maps) with found, fixed and remeasured counts and the average before/after change, a list of the worst-scoring assets first (each links to `/assets/<id>`), a blockers panel, and the findings per domain. Every finding shows its next action.

- **Auto audit and ingest**: the tick runs `nightly rsi refresh` on a schedule (`rsiRefreshHours`, default 6; `rsiAuditScript` overrides the audit script path). It runs the asset audit once per video-settings tier, ingests the result (no manual `nightly assets ingest`), creates or updates one finding per failing flag, closes it as remeasured when the flag clears (keeping the before and after scores) and opens a fix item per pack. `nightly rsi board` prints the counts, `nightly rsi sync` re-runs only the finding and blocker pass.
- **Video-settings tiers**: texture findings are judged against the low, medium and high tiers (`rsiTiers`); the board has a tier switch (`/?tier=low|medium|high`). Bolt-action cycle-clip flags show under Animations when the audit emits them.
- **Blocker minimization**: the blocker pass flags duplicate, stale (`rsiStaleDays`, default 30) and blocked items and any item parked "waiting on owner", with the reason and the next action. Stale and duplicate agent items are closed automatically with a note; only the production website deploy may wait on the owner.

## Assets tab

- **Names and map pieces**: `lib/asset-names.mjs` turns a mangled id (`maps_world__.stores__model-library__dotmap__dm_applianceebox__dm_applianceebox`) into a short display name (`Applianceebox`, group = the map or library) and defines `PIECE_SQL`: rows in a `*-maps` pack whose id has a `model-library` or `models` segment are map-embedded pieces, hidden from the Assets list and aggregates by default (toggle "show map pieces", URL `?f.pieces=1`). Nothing is deleted or rewritten: the rule is a query filter, so removing the `NOT PIECE_SQL` clause in `src/server/assetsList.ts` restores the old view. The full id stays in the hover title and on the detail page. The old `dotmap`/`dm_` words still live in on-disk folder names and the audit tool (other repos); the display strips them.
- **Missing previews**: `nightly assets scan` and `assets ingest` spawn a detached `assets thumbs --missing` (only rows never rendered); `NIGHTLY_NO_AUTO_THUMBS=1` disables it. Run `nightly assets thumbs --missing` once to backfill existing rows.

`/assets` is the asset-quality side of RSI. It covers every kind of asset (weapons, props, avatars, pickups, grenades, vehicles, viewmodel arms, buildings, or kinds you define), with kind tabs and per-kind counts, tabs Models, Textures, Animations and Sounds, and a detail page `/assets/<id>` with a 3D viewer, textures, animations, sounds, flags and score. Nothing about your packs, games or budgets is built in: **sources** (directories to scan) and **kinds** (with audit budgets) are database rows, edited on `/assets/sources` or with the CLI. A fresh install shows a first-run guide until a source exists.

### Point it at your own game

1. `nightly assets migrate` (backs up the database first when there is work), then add a source: `nightly assets source add mygame --root /path/to/game --type game` (a pack is `--type pack`). Optional: `--models "**/*.glb"`, `--exclude .git,.godot`, `--default-kind prop`; `source set NAME ...` edits, `source list`, `source rm NAME [--purge]`.
2. `nightly assets source scan [NAME...]` (or `nightly assets scan`) lists every model, texture and sound of each enabled source (no hash de-duplication: the same file in two packs is two assets).
3. Kinds: seeded with generic defaults (weapon, prop, avatar, pickup, grenade, vehicle, arms, building, other). Edit labels, the `match` regex that classifies a path, and the budgets (tris range, texture size per tier, bones, required clips, scale, pivot, LODs) on the Sources page or with `nightly assets kind ...`. A source may also carry `kindRules` (`[{"match": "...", "kind": "..."}]`) in its config.
4. Quality audit: `nightly assets config > rsi-config.json` writes the `rsi-config/1` export (tiers, sources, kinds with budgets); run an auditor against it and `nightly assets ingest audit.json` (schema `rsi-assets/2`, an `assets` array with a `kind` each; the older `weapons` array is still accepted). The panel runs the script named by the `rsiAuditScript` setting on the refresh schedule. Findings land on the RSI board under the `models`, `textures`, `animations` and `sounds` domains, judged per video tier.
5. Local setup that must not live in this repository (your own pack names, event tables) belongs in a seed script that calls the CLI against your live database.

- **Ingest**: `nightly assets ingest FILE [--require-token|--token-only]`, or `POST /api/assets/ingest`; the audit's `glb/` directory is `NIGHTLY_ASSETS_DIR`.
- **Inspect**: `nightly assets list [--kind K --pack S --flag F --min-score N --max-score N --q TEXT] [--json]`, `assets show ID`, `assets summary`, `assets history [--pack P] [--limit N]` (the audit trend: one row per pack per ingest, oldest first, with total, pass count and average score; the history is kept per pack, not per kind).
- **Findings page**: `/rsi` lists the findings of the audited assets (models, maps, animations, textures at one tier, sounds), server-paged, with status, verdict (fail, unverified, pass) and the before-to-after score trend; it mirrors `nightly rsi board`.
- **Map originals converter**: a source's `mapOriginalConverter` (see `lib/map-originals.mjs`) is often a Python script. When it is run by a `python` interpreter, the scan first probes that the modules it imports (`mapOriginalPythonModules`, default `["numpy"]`) can be imported; if not, the scan log gets one line such as `map originals of NAME skipped: converter needs the Python module 'numpy', which python3 cannot import: install it (python3 -m pip install numpy) or point mapOriginalConverter at an interpreter that has it`, and original conversion is skipped for that source instead of failing per map. A converter that reports a missing module mid-scan stops the same way. Fix: install the module for that interpreter, or use an interpreter (for example a virtualenv's `python`) in the converter command, then rescan.
- Files are served by `/api/assets/file/<id>/<glb|tex|snd>/<index>` (Range supported, only from under a source root).

## CLI

`~/stack/nightly/bin/nightly` — works from any directory and under cron's bare `PATH` (it finds `/usr/local/bin/node` itself). Every command takes `--json`. `NIGHTLY_DB=/path/to.db` points it at another file (tests, scratch copies).

```
nightly list [--status queue,in_progress,review] [--kind task,issue] [--all]
nightly show <key>
nightly add --title T [--key K] [--kind task|issue|check|study] [--body B | --body-file F | <stdin]
            [--repos a,b] [--done-when ..] [--status S] [--cadence nightly|every-2-days|weekly|monthly]
            [--priority N | --top | --after KEY] [--by <owner>|nightly|session]
nightly set <key> [--status S] [--priority N | --top | --after KEY] [--title ..] [--body B | --body-file F]
            [--repos ..] [--done-when ..] [--kind ..] [--cadence ..]
nightly note <key> [--run ID] [--by nightly] <text | --file F | <stdin>
nightly checks [--due]
nightly checked <key> [--note ..] [--run ID]
nightly run start                                   # prints the new run id
nightly run finish <id> --status ok|failed|skipped --summary S [--report-file F] [--turns N] [--minutes N]
nightly run close-stale --status ok|failed [--report-file F]   # closes runs still 'running'; prints "closed N"
nightly run list [--all] | nightly run show <id>
nightly run stop <id>                               # SIGTERM to the runner's process group
nightly schedule list                               # schedules are edited in the panel
nightly tick [--dry-run]                            # start what is due this minute (the panel runs it; or a crontab)
nightly start <schedule-id|name>                    # fire one now; prints the run id
nightly agent join <name> [--task T] [--repos a,b] [--kind session|nightly] [--run ID]
nightly agent claim <name> <path...> [--note N] [--force] [--item KEY] [--why W]
#   exit 3: a live agent holds an overlapping path. exit 4 (first claim only): the relaunch guard -- another live agent
#   works the same item (--item, or an item key in the task), or the last agent on it left no commit sha (messages,
#   leave note, item notes); prints its stop note. Read it, change the brief, then pass --why "<what changed>".
nightly agent release <name> [<path...>]
nightly agent say <name> [--to AGENT] <text>
nightly agent inbox <name> [--peek]
nightly agent board
nightly agent leave <name>
nightly get doRun                                   # prints exactly true or false
nightly set-setting doRun false
nightly brief                                       # compact digest for the run's prompt
nightly prompt list | show <name> | history <name>  # prompts and the runner script, from the DB
nightly prompt set <name> [--file F | stdin] [--note N] [--by nightly]
```

Notes:

- `list` shows open items (in progress, review, queue, blocked) ordered by status then priority; standing checks only appear with `--kind check` or `--all` (use `nightly checks`).
- `add` without `--key` makes a slug from the title (`spy-go-1` style). Default position is the bottom of its list; `add` defaults `--by nightly`.
- `set --status done|wontfix` fills `completedAt`; moving back clears it.
- A check is due when `lastRunAt` is older than 20 h (nightly), 6.5 days (weekly) or 28 days (monthly).
- `run finish`/`close-stale` store the report file truncated to ~200 KB. `close-stale` leaves runs whose process is still alive.
- `run start` under `nightly exec` prints the run `exec` created (`NIGHTLY_RUN_ID`) instead of making a new one.
- Agent paths are relative to the workspace (the directory holding this repo); `~/stack/x/` and `x` are the same claim. Two claims overlap when one path contains the other; `*` is everything. An agent silent for 60 min no longer blocks anyone; after 6 h `tick` ends it and releases its claims.

## How a run starts

```
panel (every minute, src/server/scheduler.ts) and/or crontab:  nightly tick
           └─ each enabled schedule whose cron matches this minute (and doRun=true), claimed
              atomically so two tickers cannot both fire it:
              creates Run(status running, scheduleId) and spawns, detached:
nightly exec <run>
           └─ spawns the runner: the `run.sh` prompt (kind script) written to a private temp file,
              or a path in setting `runner` / env NIGHTLY_RUNNER;
              with NIGHTLY_RUN_ID, NIGHTLY_SCHEDULE_ID/NAME, NIGHTLY_PROMPT, NIGHTLY_INSTRUCTIONS,
              NIGHTLY_MAX_TURNS, NIGHTLY_TRIGGER; streams its stdout/stderr into Run.log every 5 s;
              a line `::nightly-meta {"turns":..,"minutes":..,"costUsd":..}` fills those columns;
              when it exits, closes the run (ok/failed by exit code) unless the agent already did.
```

A schedule that does not allow overlap, due while another run is alive, gets a `skipped` run saying so. Start from `scripts/run.sh` or write your own (Prompts → New, name it `run.sh`): decide what is safe, then `claude -p "$(nightly prompt show "$NIGHTLY_PROMPT")"`. `nightly exec` also passes `NIGHTLY_ROOT`, the repository's path.

## How the agent uses it

```bash
N=$HOME/stack/nightly/bin/nightly
RUN=$($N run start)                            # the run exec created
$N agent join nightly-$RUN --kind nightly --run $RUN --task "..."
#   before changing a repo: $N agent claim nightly-$RUN <repo>  (exit 3 -> someone is there; message them, move on)
# prompt gets:  $N brief   (and the run id)
#   the agent works top-down:  $N show <key>, $N set <key> --status in_progress,
#   $N note <key> --run $RUN "where it stopped / what was done", $N set <key> --status done,
#   $N checks --due -> do each -> $N checked <key> --run $RUN --note "...",
#   new work found -> $N add --title ... --after <key> --repos ... --done-when ...
$N run finish "$RUN" --status ok --summary "one line" --report-file /tmp/report.md
$N agent leave nightly-$RUN
```

Rules carried over from the Markdown list: work Queue top-down; an item that cannot be finished in one night goes to `in_progress` with a note saying exactly where it stopped; items are written to be picked up cold (repos, files, a checkable "done when"); only the owner removes a Queue item without doing it; never delete — close as `done`/`wontfix`.

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

## Notes & FAQ

> Is this project actively maintained?

Yes and no. I still use it regularly, but I don't intend on actively developing new features or providing extensive support. As of right now, the project is perfect for personal use and meets my needs 🙂

> What is your dev environment like?

I dedicate one of my homeservers from my [home lab](https://github.com/gamemann/my-home-lab) for development work on my personal projects including [**GameSpice**](https://gamespice.net), [TekWorks](https://tekworks.net), and my other general open source projects. I run a bunch of virtual machines that Claude Code has access to, which gives them full control to actively manage and interact with the development environment without restrictions. I've cut off the homeserver from crucial parts of my network in the very small chance that Claude Code agents do go rogue and try to nuke my home network 😅

## License

MIT, see [LICENSE](LICENSE).
