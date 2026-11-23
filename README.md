<p align="center"><img src="docs/banner.png" alt="Nightly: a database and panel for autonomous Claude Code runs" width="720"></p>

Nightly is the database and web panel that autonomous [Claude Code](https://claude.com/product/claude-code) runs work from: a queue of tasks, schedules, run reports, a live board where concurrent agents claim paths, project and asset tooling for games, and the measurements that tell you whether a fix worked. It started as one cron line for my own gaming and modding project, [**GameSpice**](https://gamespice.net), and grew from there. Everything in the panel is also a command in `bin/nightly`, which needs no build and no server. The scripts, systemd units and agent instructions that run my own fleet on top of it are public in the companion repo [nightly-env](https://github.com/gamemann/nightly-env).

## Contents

| Section | What is in it |
| --- | --- |
| [What RSI means here](#what-rsi-means-here) | The find, fix, remeasure loop. |
| [Features at a glance](#features-at-a-glance) | One table for the whole panel. |
| [Architecture](#architecture) | Processes, data layers, who writes to SQLite. |
| [Users, roles and permissions](#users-roles-and-permissions) | Who sees and does what. |
| [Transcripts](#transcripts) | Claude Code conversations and the live agent board. |
| [Projects](#projects) | Folders, projects, project pages, task mapping, lines of code. |
| [Tasks](#tasks) | Queue, in progress, review, blocked, issues, done. |
| [Automation](#automation) | Workflows (schedules, runs) and checks. |
| [Usage](#usage) | Claude tokens, plan limits, GitHub API budget. |
| [Game tools](#game-tools) | Asset manager, map manager, map converter, performance, crashes, playtest, reviews, content, RSI. |
| [Account](#account) | Your profile, sessions, password. |
| [AdminCP](#admincp) | Schedules, prompts, jobs, runs, web, crash log, settings, users, roles, nodes, communication, databases, builds. |
| [Nodes](#nodes) | Planets, stations and what they offload. |
| [CLI](#cli) | The `nightly` command. |
| [Reviews, lists and paging](#reviews-lists-and-paging) | Media review items, server-side paged tables. |
| [Docker and ClickHouse](#docker-and-clickhouse) | One command for the panel plus ClickHouse. |
| [The `x-nightly` nginx proxy](#the-x-nightly-nginx-proxy) | Putting the panel on port 80. |
| [Migrating a pre-redesign database](#migrating-a-pre-redesign-database) | `scripts/migrate-live.sh`. |
| [Stack, data model and layout](#stack-data-model-and-layout) | What it is built from. |
| [Notes and FAQ](#notes-and-faq) | Maintenance, dev environment. |
| [Install](#install) | Docker Compose, bare host, nodes, nginx, first run, upgrades. |
| [License](#license) | MIT. |

Deep references live in `docs/`: [automation](docs/automation.md), [panel](docs/panel.md), [cli](docs/cli.md), [settings](docs/settings.md), [nodes](docs/nodes.md), [usage](docs/usage.md), [perf](docs/perf.md), [assets](docs/assets.md), [map-converter](docs/map-converter.md), [health-feeds](docs/health-feeds.md), [transcripts](docs/transcripts.md) and [migrate-live-to-docker](docs/migrate-live-to-docker.md).

## What RSI means here

RSI is recursive self-improvement, the loop nightly is built around: **find, fix, remeasure**. An audit or benchmark finds a problem (a model with too many triangles, a texture over budget, a frame-time regression, a failing visual check) and records it as a *finding*. A fix item goes into the queue and an agent works it. When the next audit runs and the flag has cleared, the finding closes as *remeasured*, keeping its before and after scores, so every fix is checked by a measurement instead of an opinion. The RSI board on the home page counts findings per domain; see [RSI board](docs/panel.md#rsi-board-home-page) for the details.

![RSI board](docs/screenshots/home-rsi-board.png)

## Features at a glance

| Area | What it does | Where |
| --- | --- | --- |
| Transcripts | Browse and continue Claude Code conversations; live agent board | `/transcripts` |
| Projects | Folder tree, per-project tabs, lines of code, task mapping | `/projects` |
| Tasks | Queue, in progress, review, blocked, issues, done | `/tasks/<status>` |
| Automation | Cron schedules, runs and reports, standing checks | `/automation/*` |
| Usage | Token use by project, model and tool; plan limits; GitHub API budget | `/usage` |
| Game tools | Assets, maps, converter, performance, crashes, playtests, reviews | `/tools/*` |
| Accounts | Users, roles, per-user grants, sessions | `/account/*`, `/admin/*` |
| Nodes | Offload builds, suites, GPU runs and map conversions to other machines | `/admin/nodes` |
| CLI | All of the above from a shell, with no server | `bin/nightly` |

## Architecture

```mermaid
flowchart LR
  cron["crontab: nightly tick (every minute)"] --> CLI
  CLI["bin/nightly (node:sqlite)"] --> DB[("SQLite: data/nightly.db")]
  CLI -->|detached exec| Runner["run.sh -> claude -p"]
  Runner --> Agents["agents: join, claim, say"]
  Agents --> CLI
  Panel["Next.js panel :3010 (Prisma)"] --> DB
  Panel -->|shells out to start / stop| CLI
  Panel --> CH[("ClickHouse, optional mirror")]
  Panel -->|ws :4001| Node["station / planet daemons"]
  Node --> Jobs["build, test, suite, gpu, browser, perf, map-convert, playtest"]
```

| Rule | Why |
| --- | --- |
| Runs start only through the CLI (`tick`, `start`), as a detached process. | Restarting the panel cannot kill a run. |
| The panel touches SQLite only through Prisma. | A second SQLite library in the same process drops Prisma's locks and loses writes. |
| The CLI uses `node:sqlite` directly. | It runs with no build and no server. |
| Dates are ISO-8601 text written by the application. | Never rely on a column default for a date. |
| Everything specific to one workspace lives in the database. | The repository stays public: prompts and the runner are `Prompt` rows. |

## Users, roles and permissions

Every visitor signs in. Permissions are keys such as `tasks.edit`; roles grant them, per-user grants add or deny (`!key`), and patterns like `tools.*` or `*` work. Sidebar entries, pages, API calls and single projects are all checked (folder access inherits down the tree).

| Role | Grants | Notes |
| --- | --- | --- |
| `admin` | `*` | Built in; cannot be deleted or renamed. |
| `user` | tasks view/edit, transcripts view/run, usage, automation view, tools view/run, asset upload, agents view, account edit | Built in. Projects only through project access. |
| Custom | Any keys or patterns | Made in AdminCP, Roles. |

| What | Command / where | Notes |
| --- | --- | --- |
| Add a user | `nightly user add NAME` or AdminCP, Users | Passwords are scrypt hashes; sessions store only a sha256. |
| Locked out | `nightly user set NAME --password-stdin` | Reads the new password from stdin. |
| Roles and grants | `nightly role ...`, `nightly user ...` | See [cli](docs/cli.md). |
| Project access | `nightly access ...` | Per user or role, per folder or project. |

![Roles](docs/screenshots/admin-roles.png)

## Transcripts

Claude Code conversations read from the files on disk, with a live view and the ability to start or continue one as a mapped OS user. Only an index (ids, counts, tokens, byte offsets) is stored; text is read lazily from the file. Design and settings: [docs/transcripts.md](docs/transcripts.md). The screenshots blur conversation titles and message text on purpose.

![Transcripts, new conversation](docs/screenshots/transcripts-new.png)

| What | Command / where | Notes |
| --- | --- | --- |
| History | `/transcripts` | Searchable conversation list. |
| Agents | `/transcripts/agents` | Live board: what each agent is on, claims, messages. |
| CLI | `nightly transcript list\|show\|start\|send\|stop\|refresh` | `--as USER` picks the OS user. |

![Agents board](docs/screenshots/transcripts-agents.png)

Every concurrent agent joins the board with its task, claims the paths it is changing and talks to the others through messages. A claim that overlaps a live agent's is refused; stale agents stop blocking after a while. See [How the agent uses it](docs/automation.md#how-the-agent-uses-it) and [Agents liveness](docs/health-feeds.md#agents-liveness).

## Projects

Folders and projects with filters, icons and per-project tabs. Every project shows lines of code; every folder shows the sum of what is inside.

![Projects](docs/screenshots/projects-list.png)

| Tab | What it shows |
| --- | --- |
| Overview | Totals, lines of code, language bars, history |
| Tasks | Items mapped to the project |
| Assets | Asset packs mapped to the project |
| Maps | Maps mapped to the project |
| Performance | Latest runs and trend |
| Settings | Name, repo path, icon, access |
| Addon / website | Projects of other kinds get the tabs that fit |

![Project overview](docs/screenshots/project-overview.png)

![Project tasks](docs/screenshots/project-tasks.png)

![Project assets](docs/screenshots/project-assets.png)

![Project maps](docs/screenshots/project-maps.png)

![Project performance](docs/screenshots/project-perf.png)

![Project settings](docs/screenshots/project-settings.png)

![Addon project](docs/screenshots/project-addon.png)

![Website project](docs/screenshots/project-website.png)

### Project mapping

A task names repositories; `nightly project map` links it to the projects those repositories belong to. The link is many to many (`ItemProject`): one task can belong to several projects, and a project page lists all of them.

| What | Command / where | Notes |
| --- | --- | --- |
| Link tasks, asset packs and maps | `nightly project map [--dry-run] [--json] [--remap-tasks]` | Idempotent. `--remap-tasks` re-resolves every task, not only unlinked ones. |
| Fill folders and projects | `nightly project seed` | Scans repo roots (`projectRoots` setting). |
| Add, edit, remove | `nightly project add\|set\|rm` | Icons are uploaded in the panel and sniffed by magic bytes (no SVG). |
| Bootstrap | runs mapping on every start | A failure is a warning, not a stop. |

### Lines of code

Counted by [`scc`](https://github.com/boyter/scc) with the exclusions of the owner's `loc.sh` (directories `node_modules`, `vendor`, `.godot`, `.git`; files matching `.min.` or `package-lock`; see `lib/loc-core.mjs`).

| What | Command / where | Notes |
| --- | --- | --- |
| Scan | `nightly loc [PROJECT \| --all] [--folder F] [--force] [--no-ch] [--json]` | Scans the project's `repoPath`; rescans only when git HEAD changed or with `--force`. Uncommitted edits are not noticed without `--force`. |
| Find `scc` | setting `sccPath`, env `NIGHTLY_SCC`, `PATH`, `~/bin/scc`, `/usr/local/bin/scc` | If none exists the command fails listing the places tried; it never records zeros. |
| Cache | SQLite table `LocStat` | One row per scan; the newest per project is the cache. Only the CLI writes it. |
| History | ClickHouse table `loc_history` | One row per project and per folder roll-up per scan, plus a daily snapshot. Without ClickHouse the feature degrades quietly. |
| Schedule | `nightly tick` every `locRefreshHours` | Default 24; `0` means by hand only. |
| Panel | LOC chips on cards, totals beside folders, "Sort: lines of code", Rescan (`projects.edit`) | Compact numbers (1.2k, 3.4M), exact value in the tooltip. |

More in [docs/panel.md](docs/panel.md#lines-of-code).

## Tasks

An item is a task, issue, check, study or review with a Markdown body, repos, a checkable "done when", priority and a notes thread. Priority is per status list, lower first, renumbered on every move; quick-add takes a title and Enter. Items are never deleted, they are closed as done or won't fix.

| List | What it is |
| --- | --- |
| Queue | Work waiting for an agent |
| In progress | Started; an unfinished item carries a note saying where it stopped |
| Review | Waiting for a human verdict; close it or send it back |
| Blocked | Waiting on something outside the run, reason in the notes |
| Issues | Problems found by agents or schedules |
| Done | Finished and won't-fix items with completion time and notes |

![Queue](docs/screenshots/tasks-queue.png)

![In progress](docs/screenshots/tasks-in-progress.png)

![Review](docs/screenshots/tasks-review.png)

![Blocked](docs/screenshots/tasks-blocked.png)

![Issues](docs/screenshots/tasks-issues.png)

![Done](docs/screenshots/tasks-done.png)

| What | Command / where | Notes |
| --- | --- | --- |
| List and show | `nightly list`, `nightly show KEY` | Filter by status, kind, repo. |
| Add | `nightly add --title ... --repos ... --done-when ...` | `--after KEY` orders it. |
| Move and edit | `nightly set KEY --status in_progress` | Statuses are plain strings. |
| Notes | `nightly note KEY --run $RUN "text"` | Append notes; never rewrite the body. |
| Attach | `nightly attach`, `nightly attachments` | Files go under `NIGHTLY_ATTACH`. |

## Automation

### Workflows

Cron schedules with a prompt, extra instructions for just that schedule, max turns and an overlap switch, plus a master switch and Run now. The panel's scheduler checks every minute; a crontab line works too, and two schedulers never start the same schedule twice. Each run records status, summary, turns, duration, cost, the runner log (live, with Stop) and the full report. Details: [docs/automation.md](docs/automation.md).

![Workflows](docs/screenshots/automation-workflows.png)

| What | Command / where | Notes |
| --- | --- | --- |
| Crontab line | `* * * * * /path/to/nightly/bin/nightly tick >> /path/to/nightly/data/tick.log 2>&1` | Alongside the panel scheduler or instead of it. |
| Panel scheduler off | `NIGHTLY_SCHEDULER=off` in `.env` | Then the crontab is the only scheduler. |
| Runner | `scripts/run.sh`, stored as the `run.sh` prompt | See [Runner script](docs/automation.md#runner-script). |
| Usage gate | `scripts/claude-usage.sh` | The runner does not start over the thresholds in Settings. |

### Checks

Standing checks with a cadence (nightly, every 2 days, weekly, monthly). A check is due when it has not run for its cadence; a run works through the due ones and records each with `nightly checked`. Checks have their own list, separate from the queue.

![Checks](docs/screenshots/automation-checks.png)

| What | Command / where | Notes |
| --- | --- | --- |
| Due checks | `nightly checks --due` | |
| Record one | `nightly checked KEY --run $RUN --note "..."` | Sets `lastRunAt`. |

## Usage

`/usage` shows where your Claude Code tokens go, read from the transcript files on disk: totals, a stacked chart over time, sortable breakdowns, drill-down to sessions and a "Where it goes" panel of findings. Full reference: [docs/usage.md](docs/usage.md).

![Claude usage](docs/screenshots/usage-claude.png)

| What | Command / where | Notes |
| --- | --- | --- |
| Ingest | `nightly usage ingest [--full] [--dir D]` | Incremental; dedupes by message id. Works without ClickHouse. |
| Reports | `nightly usage summary\|top <dim>\|cost\|insights\|status\|ch-setup` | All take `--json`. |
| Plan limits | `scripts/claude-usage.sh` | Exit 1 at 80% (5 hour) or 90% (weekly); exit 2 means unknown. |
| Privacy | counts, ids, tool names, model, branch, project label | No message text is stored. |
| Prices | `usagePrices` setting | Estimates, not a bill. |

| Setting | Default | Meaning |
| --- | --- | --- |
| `usageDirs` | `~/.claude/projects` | Where transcripts are read from. |
| `usageProjectMode` | `basename` | `basename`, `hash` or `none`. |
| `usagePollMin` | 8 | A repeated wait-and-check inside this many minutes counts as polling. |
| `usageBigResultTokens` | 8000 | Threshold for a "big result". |

The GitHub API page shows the shared rate-limit budget so agents back off before it runs out.

![GitHub API](docs/screenshots/usage-github.png)

## Game tools

Per-game tools in the sidebar. Their health feeds (releases, crashes, web checks, playtests, content) and gates are described in [docs/health-feeds.md](docs/health-feeds.md).

### Asset manager

Asset packs, their models, textures and sounds, upload and licence tracking, mapped to projects. Reference: [docs/assets.md](docs/assets.md).

![Asset manager](docs/screenshots/tool-asset-manager.png)

| What | Command / where | Notes |
| --- | --- | --- |
| CLI | `nightly assets ...` | See [cli](docs/cli.md). |
| Your own game | [Point it at your own game](docs/assets.md#point-it-at-your-own-game) | |

### Map manager

Maps per game, their packs, conversions and status.

![Map manager](docs/screenshots/tool-map-manager.png)

| What | Command / where | Notes |
| --- | --- | --- |
| CLI | `nightly maps ...` | See [cli](docs/cli.md). |

### Map converter

Converts maps between engine formats as an offload job on a node. Formats, CLI and settings: [docs/map-converter.md](docs/map-converter.md).

![Map converter](docs/screenshots/tool-map-converter.png)

| What | Command / where | Notes |
| --- | --- | --- |
| Convert | `nightly map-convert ...` | Jobs are rows in `map_convert_job`, run on nodes offering `map-convert`. |

### Performance

Benchmark runs per game: trends, offenders, findings, RSI, budgets and a run list with flame graphs and run-to-run diffs. Reference: [docs/perf.md](docs/perf.md).

![Performance](docs/screenshots/tool-perf.png)

![Game trends](docs/screenshots/perf-game-trends.png)

![Offenders](docs/screenshots/perf-offenders.png)

![Findings](docs/screenshots/perf-findings.png)

![Performance RSI](docs/screenshots/perf-rsi.png)

![Budgets](docs/screenshots/perf-budgets.png)

![Runs](docs/screenshots/perf-runs.png)

| What | Command / where | Notes |
| --- | --- | --- |
| Commands | `nightly perf ...` | Settings and ingest in [docs/perf.md](docs/perf.md#commands-settings-and-ingest). |
| Regression sigma | `perfRegressionSigma` | Default 3. |

### Crashes

Crash reports pushed by game machines, grouped by signature.

![Crashes](docs/screenshots/tool-crashes.png)

| What | Command / where | Notes |
| --- | --- | --- |
| CLI | `nightly crash ...` | A feed with a gate; see [health-feeds](docs/health-feeds.md). |

### Playtest

Scripted multiplayer playtests, run on a node, with results per game.

![Playtest](docs/screenshots/tool-playtest.png)

| What | Command / where | Notes |
| --- | --- | --- |
| CLI | `nightly playtest ...` | Needs a node offering `playtest`. |

### Reviews

Media review of animation, model and sound work: see [Reviews, lists and paging](#reviews-lists-and-paging).

![Reviews](docs/screenshots/tool-reviews.png)

### Content

Content publishing feed (asset and pack releases).

![Content](docs/screenshots/tool-content.png)

### RSI

Findings per domain with before and after scores; see [What RSI means here](#what-rsi-means-here).

![RSI](docs/screenshots/tool-rsi.png)

## Account

Your profile, password and sessions (sessions can be signed out one by one).

![Account settings](docs/screenshots/account-settings.png)

## AdminCP

Everything below needs an admin role or the matching `admin.*` key.

| Page | What it does |
| --- | --- |
| Schedules | Cron schedules, master switch, Run now |
| Prompts | The instructions every agent reads and the runner script, every version kept and restorable |
| Jobs | Scripts a schedule may start, see [Jobs and scripts](docs/automation.md#jobs-and-scripts) |
| Runs | History, live log, Stop, full reports searchable across runs |
| Web | Web checks and their results |
| Crash log | The panel's own error log |
| Settings | Database settings; reference in [docs/settings.md](docs/settings.md) |
| Users | Accounts |
| Roles | Roles and grants |
| Nodes | Planet and stations, see [Nodes](#nodes) |
| Communication | Messages and notifications |
| Databases | Connections to ClickHouse, Postgres, MySQL, SQLite; a `secretRef`, never a password |
| Builds | Build and offload queue |

![Schedules](docs/screenshots/admin-schedules.png)

![Prompts](docs/screenshots/admin-prompts.png)

![Jobs](docs/screenshots/admin-jobs.png)

![Runs](docs/screenshots/admin-runs.png)

![Web](docs/screenshots/admin-web.png)

![Crash log](docs/screenshots/admin-crashlog.png)

![Settings](docs/screenshots/admin-settings.png)

![Users](docs/screenshots/admin-users.png)

![Nodes](docs/screenshots/admin-nodes.png)

![Communication](docs/screenshots/admin-communication.png)

![Databases](docs/screenshots/admin-databases.png)

![Builds](docs/screenshots/admin-builds.png)

Prompts and the runner script live in the database, edited in the panel with every version kept. Settings keys (runner environment, panel and CLI environment, database settings) are in [docs/settings.md](docs/settings.md).

## Nodes

A node is a machine the panel knows about. Full reference: [docs/nodes.md](docs/nodes.md).

| Type | What it is | Runs |
| --- | --- | --- |
| `planet` | The machine the panel and agents live on (`nightly node planet`) | Everything local; also takes offloads. |
| `station` | An offload box | Only the kinds it advertises. |

| Offload kind | What it runs |
| --- | --- |
| `build` | Game and site builds |
| `test` | Test runs |
| `suite` | Full suites |
| `gpu` | GPU runs |
| `browser` | Playwright and browser checks |
| `perf` | Benchmarks |
| `map-convert` | Map conversions |
| `playtest` | Playtests |

| Spec | Default | Meaning |
| --- | --- | --- |
| `buildSlots` | `max(1, floor(threads / 8))` | Builds at once. |
| `heavySlots` | 1 | Heavy jobs (suites, GPU) at once. |
| `offloadKinds` | `build, test, suite` | What the node accepts. |
| `workspace`, `projectPaths` | none | Where jobs run, and each project's checkout on the node. |
| port | 4001 | The daemon (`bin/nightly-node`); `--tls` for wss. |
| token | shown once | Only its sha256 is stored. Link auth is `ssh-key` or `password`; key material is never stored. |

## CLI

`bin/nightly` works from any directory and under cron's bare `PATH`. Every command takes `--json`; `NIGHTLY_DB=/path/to.db` points it at another file. The full command list is [docs/cli.md](docs/cli.md).

![Terminal](docs/screenshots/cli-terminal.png)

| Group | Commands | What it does |
| --- | --- | --- |
| Tasks | `list show add set note attach attachments checks checked brief` | Queue, items, notes, checks. |
| Runs | `run`, `schedule list`, `tick`, `start` | Runs and schedules. |
| Prompts | `prompt list\|show\|history\|set\|rename` | Versioned prompts and scripts. |
| Agents | `agent join\|claim\|release\|say\|inbox\|board\|leave\|heartbeat\|sweep\|running` | The live board. |
| Projects | `folder`, `project`, `access`, `loc` | Tree, mapping, lines of code. |
| Nodes | `node`, `dbconn`, `build`, `offload` | Hosts, databases, builds. |
| People | `user`, `role` | Logins and grants. |
| Assets and maps | `assets`, `maps`, `map-convert`, `rsi` | Game tools. |
| Perf and feeds | `perf`, `releases`, `crash`, `web`, `playtest`, `content`, `feed`, `gates` | Health feeds. |
| Usage | `usage`, `account`, `transcript` | Tokens, accounts, conversations. |
| Misc | `gh`, `ci`, `check`, `get`, `set-setting` | Budgets, CI, settings. |

`agent claim` exits 3 when a live agent holds an overlapping path and 4 on the relaunch guard; the codes are listed in [Agent claims and exit codes](docs/cli.md#agent-claims-and-exit-codes).

## Reviews, lists and paging

Reviews judge animation, model and sound work, where a green test says nothing about whether it looks or sounds right. A builder files a review item and posts media under one entry per weapon, character or sound.

| Kind | What it shows |
| --- | --- |
| Clip | Looping before and after video with a slider, A/B and side-by-side, frame stepping, speed, timing strip, metrics table. |
| Filmstrip | A timing strip of frames, before and after. |
| Image / screenshot | Before and after in a viewer with zoom, pan, native size. |
| Audio | Player, waveform, licence and source line. |

| What | Command / where | Notes |
| --- | --- | --- |
| Post media | `scripts/review-post.sh` | Files go under `NIGHTLY_REVIEWS` with a `review.json`; no database table. |
| Read verdicts | `scripts/review-post.sh open KEY` or `nightly review open KEY` | Fix what is marked "Still wrong", re-post as `after`. |
| Lists | `DataTable`, `ListControls` | Page, size, sort, search and filters live in URL params, one namespace per table. |

More: [Reviews](docs/panel.md#reviews) and [Lists and paging](docs/panel.md#lists-and-paging).

## Docker and ClickHouse

`docker compose up -d --build` runs the panel and ClickHouse together. On every start the panel creates its SQLite tables, the ClickHouse database and tables (auto-schema from `deploy/clickhouse/schema.sql`, `ReplacingMergeTree`) and the first admin. Copy [`.env.example`](./.env.example) to `.env` first.

| Setting (`.env`) | Default | Meaning |
| --- | --- | --- |
| `NIGHTLY_ADMIN_USER` / `NIGHTLY_ADMIN_PASSWORD` | `admin` / generated | First admin; a blank password is generated and printed once in `docker compose logs panel`. |
| `NIGHTLY_PORT` / `NIGHTLY_BIND` | `3010` / `0.0.0.0` | Where the panel is published. |
| `NIGHTLY_CLICKHOUSE_PORT` / `NIGHTLY_CLICKHOUSE_BIND` | `8123` / `127.0.0.1` | Where ClickHouse HTTP is published. |
| `NIGHTLY_CLICKHOUSE_PASSWORD` | dev default | Change before exposing the port. |
| `COMPOSE_PROJECT_NAME`, `NIGHTLY_PANEL_CONTAINER`, `NIGHTLY_CLICKHOUSE_CONTAINER` | `nightly`, fixed names | Set all three to run a second stack beside another. |
| `NIGHTLY_CGROUP_PARENT` | empty (Docker default) | cgroup slice for both containers; see below. |

Both services have healthchecks (`docker compose ps`). Data lives in the volumes `panel-data` (`/data`, SQLite) and `clickhouse-data`; `docker compose down` keeps them, `down -v` deletes them. Add a node by registering `host:4001` and its token in the panel (Nodes), after `install/install-node.sh --station` on that machine.

A host can put every container in a memory-capped slice (`cgroup-parent` in `/etc/docker/daemon.json`). When that slice is over its `memory.high`, the kernel throttles every process in it, healthcheck `exec`s included: the container then shows `unhealthy` with `timed out starting health check` and never serves. Set `NIGHTLY_CGROUP_PARENT=system.slice` (or another uncapped slice) in `.env` on such a host.

ClickHouse is optional. Without it `nightly usage ingest` fills local SQLite tables and the Usage page reads them; with it the page prefers ClickHouse while it answers and falls back with a notice. Set `usageChEnabled=true` (and `usageChUrl`, `usageChDb`, `usageChUser`) in Settings; the password comes from the environment. Moving an existing bare-host install into Docker: [docs/migrate-live-to-docker.md](docs/migrate-live-to-docker.md).

## The `x-nightly` nginx proxy

[`deploy/nginx/x-nightly.conf`](./deploy/nginx/x-nightly.conf) is a site that listens on port 80 and proxies to the panel on `127.0.0.1:3010`.

| Setting | Value | Why |
| --- | --- | --- |
| `client_max_body_size` | 512M | Review media and attachments. |
| Upgrade headers | websocket | Live logs and the transcript stream. |
| `proxy_read_timeout` | 3600s | Long-lived streams. |

Set your own `server_name` in the copy you install; see [Install: nginx](#4-nginx-site).

## Migrating a pre-redesign database

The redesign adds accounts, projects, folders and nodes on top of the old tables; it never drops or rewrites them. Move an existing database over with [`scripts/migrate-live.sh`](./scripts/migrate-live.sh):

```bash
# Back up and count rows only; changes nothing. Safe while the old panel runs.
scripts/migrate-live.sh --dry-run

# Stop the old panel, then migrate (default database: $NIGHTLY_DB, else data/nightly.db).
NIGHTLY_ADMIN_USER=admin NIGHTLY_ADMIN_PASSWORD='...' scripts/migrate-live.sh [--db FILE] [--roots /path/a:/path/b]
```

| Step | What happens |
| --- | --- |
| 1 | Online `sqlite3 .backup` (WAL-safe) to `<db dir>/backup/nightly-pre-redesign-<UTC>.db`, then `quick_check`. |
| 2 | `lib/bootstrap.mjs` adds tables, columns and roles and creates the admin. The old login (`authUser`/`authHash`) carries over; without one the admin comes from `NIGHTLY_ADMIN_USER`/`NIGHTLY_ADMIN_PASSWORD` or gets a generated password printed once. If the old panel ran without a login, `ingestOpen` stays on so existing ingest clients keep working. |
| 3 | `nightly node planet`. |
| 4 | `nightly project seed` fills folders and projects. |
| 5 | Row counts are compared; exit 1 if any old table lost a row. |

The script is idempotent: a second run only takes another backup. To restore, stop the panel, copy the backup over the database and delete its `-wal` and `-shm` files. Test on a copy first: `sqlite3 "file:data/nightly.db?mode=ro" ".backup /tmp/copy.db"`, then run with `--db /tmp/copy.db`.

## Stack, data model and layout

Stack: Next.js 16 (App Router) · tRPC v11 · Prisma 7 (SQLite via `@prisma/adapter-better-sqlite3`) · Tailwind v4 · React 19. The CLI is plain Node ESM on `node:sqlite`.

The data model (`Item`, `Note`, `Run`, `Schedule`, `Agent`, `Claim`, `Message`, `Prompt`, `PromptVersion`, `Setting`, plus projects, users and nodes; see `prisma/schema.prisma`) and the file layout are listed in [docs/panel.md](docs/panel.md#data-model) and [docs/panel.md](docs/panel.md#layout).

Usage tables (`usage_*`) are created by `nightly usage ingest`, outside the Prisma schema, so `prisma db push` does not manage them.

## Notes and FAQ

> Is this project actively maintained?

Yes and no. I still use it regularly, but I don't intend on actively developing new features or providing extensive support. As of right now, the project is perfect for personal use and meets my needs 🙂

> What is your dev environment like?

I dedicate one of my homeservers from my [home lab](https://github.com/gamemann/my-home-lab) for development work on my personal projects including [**GameSpice**](https://gamespice.net), [TekWorks](https://tekworks.net), and my other general open source projects. I run a bunch of virtual machines that Claude Code has access to, which gives them full control to actively manage and interact with the development environment without restrictions. I've cut off the homeserver from crucial parts of my network in the very small chance that Claude Code agents do go rogue and try to nuke my home network 😅

> Where are the scripts that run your fleet?

In the companion repo [nightly-env](https://github.com/gamemann/nightly-env): scripts, systemd units, offload helpers and agent instruction files. nightly stays generic; nightly-env is one concrete setup.

## Install

### 1. Docker Compose

```bash
git clone https://github.com/gamemann/nightly
cd nightly
cp .env.example .env          # set NIGHTLY_ADMIN_PASSWORD and NIGHTLY_CLICKHOUSE_PASSWORD
docker compose up -d --build
docker compose ps             # both services should become healthy
docker compose logs panel     # the generated admin password is printed here once
```

The panel is on `http://HOST:3010` (`NIGHTLY_PORT`, `NIGHTLY_BIND`); sign in as `NIGHTLY_ADMIN_USER`. See [Docker and ClickHouse](#docker-and-clickhouse) for every variable.

### 2. Bare host

Needs Node 22 or newer (the CLI uses `node:sqlite`) and git.

```bash
git clone https://github.com/gamemann/nightly
cd nightly
npm install                   # installs and generates the Prisma client
npm run db:push               # creates data/nightly.db from prisma/schema.prisma
NIGHTLY_ADMIN_USER=admin NIGHTLY_ADMIN_PASSWORD='choose-one' npm run bootstrap   # first admin and roles
npm run build
npm start                     # next start on port 3010
```

To keep it running, use the systemd user unit [`deploy/nightly-panel.service`](./deploy/nightly-panel.service):

```bash
# Set WorkingDirectory (your clone) and the npm path in the unit first.
mkdir -p ~/.config/systemd/user
cp deploy/nightly-panel.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now nightly-panel
# Keep it running when you are not logged in.
loginctl enable-linger "$USER"
```

Without systemd, [`scripts/restart-panel.sh`](./scripts/restart-panel.sh) stops whatever listens on `NIGHTLY_PORT` (3010) and starts a fresh detached `npm start`, logging to `data/panel.log`; `--stop` only stops it. Add the scheduler crontab line from [Workflows](#workflows) if you turn the panel scheduler off.

### 3. Nodes

On each machine that should take offloads:

```bash
sudo install/install-node.sh --station --name builder-1 --kinds build,test,suite
sudo install/install-node.sh --planet [--panel]
install/install-node.sh --station --dry-run     # print what would be done
```

The script installs `deploy/nightly-node.service`, prints the token once and keeps an existing token on re-runs. Other options: `--port` (4001), `--token`, `--workspaces`, `--tls`, `--user`, `--prefix DIR`, `--no-systemd`, `--uninstall [--purge]`. Then register `host:4001` and the token under AdminCP, Nodes. Details: [docs/nodes.md](docs/nodes.md#installing-the-daemon).

### 4. nginx site

```bash
sudo cp deploy/nginx/x-nightly.conf /etc/nginx/sites-available/x-nightly
sudo editor /etc/nginx/sites-available/x-nightly      # set your own server_name
sudo ln -s /etc/nginx/sites-available/x-nightly /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 5. First-run checklist and upgrades

A new database is blank and paused.

| Step | Where |
| --- | --- |
| Sign in with the admin you created | `/login` |
| Add a runner script named [`run.sh`](./scripts/run.sh) and a prompt | AdminCP, Prompts |
| Add a schedule | AdminCP, Schedules |
| Switch **Nightly run** on | AdminCP, Settings |
| Seed and map projects | `nightly project seed`, `nightly project map` |
| Optional: nodes, ClickHouse, a `usageDirs` ingest | [Nodes](#nodes), [Usage](#usage) |

Upgrade steps:

```bash
git pull --ff-only
npm install                             # after a dependency change
npx prisma generate                     # always after a schema change
npm run build
scripts/restart-panel.sh                # or: systemctl --user restart nightly-panel
```

Schema changes apply additively on start (`lib/bootstrap.mjs`). Docker: `git pull && docker compose up -d --build`. Checks before committing a change: `npm run typecheck && npm run build && npm test`.

## License

MIT, see [LICENSE](LICENSE).
