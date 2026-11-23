# Health feeds and gates

Generic, DB-driven pages, each with a CLI and a Bearer ingest (`POST /api/ingest/<kind>`, token from `nightly perf token add`): Releases (`/releases`, `nightly release`), Crashes (`/crashes`, `nightly crash`), Web checks (`/web`, bundle size, web vitals, uptime with budgets, `nightly web`), Playtests (`/playtests`, `nightly playtest`), Content (`/content`, `nightly content`). Failing checks raise RSI findings. The perf, visual and netchaos gates (`lib/gates.mjs`) open one RSI finding per failing check and close it when a later run passes; the finding says to re-baseline only if the change is intended.

#### Releases and deploys

`/releases` lists one row per version tag: repo, version, channel, CI, deployed to, rollback target, age. The **Releases sync** schedule (hourly, script `releases-sync.sh`) runs `nightly releases sync`, which imports the `v*.*.*` tags of every real git repo directly under the setting `releasesRoots` (default a colon-separated list of repo roots; symlinked aliases are skipped), with tag date, notes (annotation subject plus the commits since the previous tag) and the rollback target (previous version of the channel). A prerelease tag (`v1.2.3-rc1`) is channel `dev`, the rest `stable`. CI comes from `gh run list` for the 10 newest tags of a repo, one call per repo, only while a tag is unresolved, never below 500 GitHub requests left and at most 40 s per run (the next run continues). Sync never writes **Deployed to**: nothing records deploys except you.

The panel (Add release, Edit, Mark deployed, Remove env, Delete, Sync now) and the CLI use the same functions in `lib/feeds.mjs`; the panel calls the CLI. `nightly releases ...` (add `--json` for machine output):

- `list [--game G] [--limit N]`
- `add --repo R --version V [--channel stable] [--ci passing] [--changelog T] [--rollback V] [--deployed-to dev,prod] [--game G] [--at DATE]` creates or updates a release
- `set --repo R --version V [--channel C] [--changelog T] [--ci unknown|pending|passing|failing] [--rollback V] [--game G] [--commit SHA] [--at DATE]` edits an existing one
- `deploy --repo R --version V --to ENV [--channel C]` marks it deployed (the environment moves off older versions); `undeploy --repo R --version V --from ENV` removes the mark
- `rm --repo R --version V [--channel C]` deletes a record
- `sync [--no-ci]` the importer above
- ingest: `nightly feed add release -` or `POST /api/ingest/release` with the perf Bearer token

#### Crashes, Web checks, Playtests, Content

Same shape for all four: the panel's Add / Edit / Delete buttons and the CLI call the same functions in `lib/feeds.mjs` (the panel shells out to `bin/nightly`). Every command takes `--json`; `<kind> edit <id> --field value ...` and `<kind> delete <id>` use the ids `list` prints. `webcheck` is an alias of `web`.

- `nightly crash list|add|edit|delete|summary|set|scan`. `add --game G --signature S [--version V --platform P --count N --sample T]` upserts and counts up; a fixed group reopens when it recurs. `scan [--journal] [--since 90d] [--logs DIR,DIR] [--platform linux]` imports engine crash logs (`handle_crash: Program crashed with signal N`, signed by signal and library offset) and journal OOM kills (game `dev-host`) as absolute counts, so re-running never double counts. Schedule `Crash scan` (hourly). Not imported: coredumps and server journals of other hosts (not readable from this box).
- `nightly webcheck list|add|edit|delete|budget|probe|summary`. `add --game G --metric M --value N`; `budget --game G --metric M --max N [--unit U]` sets and `budget --delete --game G --metric M` removes a budget. `probe [--targets JSON] [--dry] [--frame]` fetches every target once and records `http_fail` (1 = failed) and `latency_ms`; schedule `Web checks` (every 15 minutes). Targets come from the setting `webProbeTargets` (`nightly set-setting webProbeTargets '[{"game":"site","url":"https://..."}]'`), never from the repo. `--frame` also checks a Solo embed frame and needs Playwright installed.
- `nightly playtest list|add|edit|delete|summary|record|import-perf`. `add --game G [--build B --tester T --rating 1-5 --tags a,b --text T]`. Bot runs: `record --game G [--build B] [--map M --mode M --bots N --result pass|fail --crashes N --avg_fps N --duration_s N] [--from-soak FILE|-]` stores one row (tester `bots`, facts as `key=value` text); `import-perf` backfills rows from stored perf runs that had bots. Schedule `Bot playtest` (daily) runs `tools/soak.tscn` of each game through `hv`, which offloads to a build slot or the GPU boxes. The soak is headless, so it reports tick time, not fps.
- `nightly content list|add|edit|delete|summary|scan`. `add --game G --name N --metric M --value V [--category C --min N --max N]`; a value outside its band opens an RSI finding. `scan [--packs DIR,DIR]` reads the weapon resources of the packs in the setting `contentWeaponPacks` and stores their numbers (schedule `Content scan`, daily). Bands are left empty until someone sets them.

## Agents liveness

`nightly agent join|heartbeat|leave` (or `POST /api/agents/heartbeat` with the ingest token) registers any runner. An agent is live for an hour after its last heartbeat, then stale, then left after the setting `agentLeftHours` (default 12). The Agents page lists a "Running (unregistered)" section from the setting `agentSourceCmd` (a command printing one agent per line) or `agentSourceFile`.

