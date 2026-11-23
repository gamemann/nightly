# Settings reference

Every knob in one place: environment variables (`.env`, loaded by the CLI and the panel) and database settings (Settings page, AdminCP, or `nightly set-setting KEY VALUE`; read one with `nightly get KEY`). Rules: `0` means unlimited, a bad value fails loudly, and host names live in the database, never in the repository. Back to the [README](../README.md#settings).

## Runner environment

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

## Panel and CLI environment

| Variable | Default | What it does |
| --- | --- | --- |
| `NIGHTLY_DB` | `data/nightly.db` | The SQLite file the CLI and panel use (tests, scratch copies). |
| `NIGHTLY_SCHEDULER` | on | `off` turns the panel's built-in scheduler off (use the crontab line instead). |
| `NIGHTLY_DEV_ORIGINS` | none | Host names you open the dev panel from; without it `npm run dev` serves the page and never hydrates. |
| `NIGHTLY_MEDIA` | `archive/screenshots` | Screenshots, laid out `<YYYY-MM-DD>/...`, served at `/media/...`. |
| `NIGHTLY_ATTACH` | `data/attachments` | Item attachments, `<item>/` with an `index.json`; also `qa-<id>/` images. |
| `NIGHTLY_REVIEWS` | `data/reviews` | Review media, `<key>/<weapon>/` with a `review.json`. |
| `NIGHTLY_ICON_DIR` | `data/icons` | Uploaded project icons. |
| `NIGHTLY_PUBLIC_URL` | `http://<hostname>:3010` | Base URL `nightly show` prints for attachments. |
| `NIGHTLY_ADMIN_USER`, `NIGHTLY_ADMIN_PASSWORD` | `admin`, generated | First admin on a fresh database. |
| `NIGHTLY_PERF_TOKEN` | none | Ingest token read by the CLI (never passed as an argument). |
| `NIGHTLY_USAGE_TOKEN` | none | Bearer token for `POST /api/usage/ingest`. |
| `NIGHTLY_USAGE_DIRS` | `~/.claude/projects` | Transcript directories for usage ingest. |
| `NIGHTLY_ASSETS_DIR` | `data/rsi-assets` | Where the asset audit writes; overrides `rsiAuditDir`. |
| `NIGHTLY_RSI_AUDIT` | none | Audit script path; the `rsiAuditScript` setting wins. |
| `NIGHTLY_NO_AUTO_THUMBS` | unset | `1` stops scans and ingests from spawning the thumbnail job. |
| `NIGHTLY_SCC` | none | Path of the `scc` binary for lines of code. |
| `QA_URL`, `QA_USER`, `QA_PASSWORD` | none | Used by `scripts/qa-post.sh` and `scripts/review-post.sh` to post to the panel. |
| `NIGHTLY_CLICKHOUSE_PASSWORD` | dev default | ClickHouse password; read through the env var named by `usageChPasswordEnv`. |

Docker-only variables (`NIGHTLY_PORT`, `NIGHTLY_BIND`, `NIGHTLY_CLICKHOUSE_*`, `NIGHTLY_CGROUP_PARENT`, container names) are in the README's [Docker section](../README.md#docker-compose).

## Database settings

| Area | Setting | Default | Meaning |
| --- | --- | --- | --- |
| Scheduler | `doRun` | false | Master switch; false pauses every schedule (Run now ignores it). |
| Scheduler | `runner` | none | Path of a runner script when it is not the `run.sh` prompt. |
| Perf | `perfMaxArtifactBytes` | 50000000 | Largest stored report artifact. |
| Perf | `perfMaxShotBytes` | 5000000 | Largest run screenshot. |
| Perf | `perfMaxShotsPerRun` | 30 | Screenshots kept per run. |
| Perf | `perfRetentionDays`, `perfRetentionRuns` | 0 | Retention of raw runs. |
| Perf | `perfMaxFunctions` | 0 | Functions stored per run (0 = all). |
| Perf | `perfBreachItems` | 1 | `0` stops budget breaches filing queue items. |
| Perf | `perfNightlyAt` | `03:40` | Daily time for `perf nightly`; empty = off. |
| Perf | `perfRequireToken` | 0 | `1` demands an ingest token even when none is issued. |
| Perf | `perfRegression` | 1 | `0` turns regression detection off. |
| Perf | `perfRegressionRuns` | 5 | Previous runs whose median is the baseline. |
| Perf | `perfRegressionNoisePct` | 5 | Smallest step, in percent of the median, that counts. |
| Perf | `perfRegressionSigma` | 3 | Multiplier on 1.4826 x MAD for jittery metrics. |
| Perf | `perfRegressionMinRuns` | 3 | Runs needed before a regression can fire. |
| Perf | `perfOffenderTop` | 3 | Functions per game that get an item. |
| Perf | `perfOffenderRuns` | 5 | Newest runs the self-time average covers (0 = all). |
| Perf | `perfOffenderMinMs` | 1 | Minimum ms per frame to count. |
| Perf | `perfOffenderItems` | 1 | `0` turns offender items off. |
| RSI | `rsiRefreshHours` | 6 | How often `tick` runs `rsi refresh`. |
| RSI | `rsiAuditScript`, `rsiAuditDir`, `rsiTiers`, `rsiStaleDays` (30), `rsiCensusDir`, `rsiMeshBudget`, `rsiAlphaBoxBudget` | see [panel](panel.md#rsi-board) | Audit tool, output, tiers and map budgets. |
| Usage | `usageDirs`, `usageProjectMode`, `usageAutoIngestMinutes`, `usagePollMin` (8), `usageBigResultTokens` (8000), `usagePrices` | see [usage](usage.md) | Transcript reading and price estimates. |
| Usage | `usageChEnabled`, `usageChUrl`, `usageChDb`, `usageChUser`, `usageChPasswordEnv` | off | Optional ClickHouse mirror. |
| Projects | `projectRoots` | none (set a colon-separated list) | Repo roots `project seed` scans. |
| Projects | `sccPath`, `locRefreshHours` | none, 24 | Lines-of-code counter path and refresh (0 = by hand). |
| Releases | `releasesRoots` | none (set a colon-separated list) | Repos whose `v*.*.*` tags `releases sync` imports. |
| Feeds | `webProbeTargets`, `contentWeaponPacks` | none | Probe targets and weapon packs, set per workspace. |
| Agents | `agentLeftHours`, `agentSourceCmd`, `agentSourceFile` | 12, none, none | Stale-agent cutoff and the unregistered-agent source. |
| Maps | `mapConverterPath`, `mapCompiler`, `mapOriginalConverter`, `mapOriginalPythonModules` (`["numpy"]`), `mapOriginalRoots`, `mapOriginalMatch`, `mapOriginalTimeoutSec` | none | See [map converter](map-converter.md). |
| Uploads | `uploadMaxMb`, `uploadMaxMb.<type>` | see Settings | Size limits for asset and map uploads (0 = unlimited). |
| CI | `ciTtlMin` | 10 | Cache time for CI workflow runs. |
