The redesign is tracked in phases; the brief is [redesign-plan.md](./redesign-plan.md). This page lists what each phase delivered and where the next one hooks in. Search the code for `EXTENSION POINT` to find the marked hooks.

## Phase 1: foundation (done)

- **Accounts.** Users, roles, per-user grants, DB sessions, login with rate limiting, CSRF same-origin check, permission-checked tRPC routers (`ROUTER_PERMS`, `permProcedure`), page guards, permission-hidden sidebar. The bootstrap migrates the old single login into an admin user. CLI: `nightly user|role|folder|project|access|node|dbconn|build`.
- **Shell.** Night theme (starfield, moon), collapsible responsive sidebar, sections Transcripts, Projects, Tasks, Automation, Usage, Game Tools, Account, AdminCP. Home is the RSI board. Old URLs redirect (`next.config.ts`).
- **Projects.** `/projects`: folder tree, search, type and archived filters, new folder and project forms. `/projects/<slug>/<tab>`: overview with edit and delete, tasks, perf, builds, settings with icon upload. Access per project or folder (`ProjectAccess`) inherits down the tree.
- **Account.** `/account/settings`: name, password change, sessions, sign out others.
- **AdminCP.** Users (roles, grants, disable, delete; the last enabled admin cannot be removed) and Roles (permission grid by area, patterns). Nodes, Communication, Databases and Builds pages come from the node work (`nodeOps` router).
- **Transcripts.** The section shell and sidebar entry; the transcript reader, new chat and agents pages came with phase 2 (`src/app/transcripts/`).
- **Tests.** `lib/permissions.test.mjs` (password hashing, legacy hashes, permission resolution, project access inheritance, folder tree, router permissions), `lib/bootstrap.test.mjs`, `lib/icons.test.mjs`.

## Phases 2 to 4 and integration (done)

- **Transcripts** (phase 2): reader, new chat, agents, `/transcripts/session/<id>`; `nightly transcripts scan` fills them. Settings > Transcripts holds `transcriptDirs`, `transcriptsIdleMinutes` and `transcriptsDefaultUser` (validated on save). See [transcripts.md](./transcripts.md).
- **Automation** (phase 3): Workflows (CI runs and releases) and Checks.
- **Game Tools and project tabs** (phase 4): assets, maps, map converter, crashes, playtest, perf, reviews, RSI; project tabs assets, maps, crashes and playtest read the project the page already loaded.
- **AdminCP**: Schedules, Prompts, Jobs & Scripts, Runs & reports, Web checks, Crash Log, Settings, Users, Roles, Nodes, Communication, Databases, Builds. Permissions are split: `admin.nodes`, `admin.comm`, `admin.databases`, `admin.builds`; `nodes.view` reads.
- **Nodes.** One router pair: `node*` (reads, users, links, databases, builds) and `nodeOps` (create, edit, rotate, detect, delete). Each node can set a workspace root and per-project paths (`specs.workspace`, `specs.projectPaths`); a job's cwd is the project path, else `<workspace>/<repo folder>`, else the panel's own path (planets only). `nodeCwd` in `lib/node-sched.mjs`.
- **Offloaded jobs.** Builds and station playtests go through the node scheduler (`dispatchQueued` in `src/server/nodeManager.ts`). A playtest for a station is queued as `offload:<id>`; the node's result comes back through `nightly offload mark|finish`, so the panel never opens the CLI's tables for writing. When no node offers the kind at all, the job runs on the panel host, up to `NIGHTLY_LOCAL_JOBS` at once (default 1, 0 = unlimited). When nodes offer it but are busy or offline, the job waits for them.
- **Map converter.** `nightly map-convert FILE --to FMT [--bin GEOMETRY]` chains converters as one job; `--bin` passes the geometry file of a GameSpice mesh manifest (the upload form has a second file field for it). Quake `.map` input is detected by content, not only by extension. BSP and station conversions need `gs-map-convert` configured on the host; dev has only the built-in quake and gs-map paths.
- **Map conversion stays local.** Stations install only `nightly-node`, with no `nightly` CLI and no file transfer, so `map_convert_job` always runs on the panel host. Moving it needs input/output transfer in the node daemon first.

## Verified at integration

- Every plan bullet was checked on the dev panel as an admin and as an ordinary user. The ordinary user sees no AdminCP links, and admin pages answer with no access. There were no console errors on any page. Screenshots: [docs/screenshots](./screenshots/).
- Parity with the old panel: all 22 old-only routes redirect to their new homes (`next.config.ts`; `/admin` lands on Schedules). The settings keys match, plus `ingestOpen`. The 14 schedules match.
- `scripts/migrate-live.sh` was run twice on a fresh `.backup` copy of a production database. Run 1 created the new tables, the admin and the planet node, and seeded 138 projects in 8 folders. Run 2 changed nothing. No old table lost rows. A panel served from the migrated copy logged in, and every page answered 200 with the old runs, schedules and tasks.
- Not verified on dev: BSP and station map conversion (no `gs-map-convert` configured), and the ClickHouse usage mirror (dev credentials are rejected; the sqlite fallback is used). A transcript run as an OS user needs that user's own `claude` login.

## Adding to the panel

- A new page: put it under its section in `src/app/`, call `guard('<perm>')` first, and add a sidebar entry with the same `perm` in `src/lib/nav.ts`.
- A new permission: add it to `PERMISSIONS` in `lib/permissions.mjs` (and to a default role if everyone should have it). The Roles page picks it up.
- A new router: register it in `src/server/api.ts` and give it a base permission in `ROUTER_PERMS`; routers without one need only a session, so guard each procedure with `permProcedure` or `assertProject`.
- A new project tab: add a row to `TABS` with its permission; the tab reads the project the page already loaded.
