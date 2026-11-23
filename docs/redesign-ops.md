# Ops: automation, tools, usage

Routes (all dark-theme, `src/components/ui/Page.tsx` shell):

| Route | Component | Needs |
|---|---|---|
| `/automation/workflows` | `automation/Workflows` (CI runs, Forgejo first, GitHub via the gh wrapper; per-project filter; re-run/cancel GitHub only) | view: `automation.view`, act: `automation.edit` |
| `/automation/checks` | `automation/Checks` (scripts/chk-*.sh schedule + kind=check items, run now) | `automation.view` / `automation.edit` |
| `/usage`, `/usage/github` | Claude usage (existing) and `usage/GithubUsage` (buckets, history chart, callers, calls, low-budget warning) | `usage.view` |
| `/tools/playtest[?game=]` | `tools/PlaytestPanel` (Trigger playtest Planet/Station, job status + log, playtests linked to perf runs) | `tools.view`, trigger: `playtest.trigger` |
| `/perf`, `/crashes`, `/playtests` | existing pages |  |
| `/queue /in-progress /review /blocked /issues /done` | `ItemList`; filters kind, status, project (`repos` contains slug) | |

Project tabs: `tools/PerfTab`, `PlaytestTab`, `CrashesTab` each take `projectSlug` (= game slug). The project page (foundation) mounts them.

Perf <-> playtest link: `nightly playtest import-perf` records a Playtest (tester `bots`, source perf-run) at the perf run's `ranAt`; `ops.links.forGame` joins on (game, at). Automatic playtests show an "automatic" badge and a link to their perf run.

## Permission seam
`requirePerm(ctx, key, projectSlug?)` in `src/server/opsRouter.ts`: if the tRPC context carries `perms: { can(key, project?) }` a missing grant is FORBIDDEN; with no `perms` (legacy single login) everything is allowed. `ctx.user.name` becomes `requestedBy`. The foundation session layer only has to set `ctx.perms`.

## Tables and CLI
Created by `lib/ops-store.mjs`: gh_call, gh_rate, ci_run, ci_repo, check_script, check_run, offload_job. Panel reads via Prisma raw SQL; every write shells out to `bin/nightly`:
`gh status|calls|sample`, `ci sync|list|rerun|cancel`, `check scripts|add|edit|rm|run|runs|due`, `offload run|list|show|start|reap`. The tick samples gh hourly, runs due checks, reaps stale jobs and syncs CI when setting `ciAutoSync=true`.
Settings: `ghWarnPct`, `ghMinLeft`, `ciAutoSync` (Settings page, "Automation and GitHub").

## tools/playtest.sh contract
A project's `tools/playtest.sh --map M --bots N --duration S` (path overridable by project setting `playtestScript`); a `SOAK` line in its output is parsed into the bot playtest; the job log is the script output tail.
