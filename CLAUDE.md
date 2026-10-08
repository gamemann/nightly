# nightly — conventions

The database the autonomous Claude runs work from (to-dos, schedules, run reports, the agent board), plus a web panel for Christian. The crontab holds one line, `bin/nightly tick` every minute; schedules, runs and their logs live in the DB.

- **Two data layers, one schema.** `prisma/schema.prisma` owns the schema (`npm run db:push`). The panel (`src/`) uses the Prisma client (better-sqlite3 adapter). The CLI (`bin/nightly` → `bin/nightly.mjs` → `lib/store.mjs`, `lib/runner.mjs`, `lib/agents.mjs`, `lib/prompts.mjs`) uses `node:sqlite` directly so it runs with no build and no server. A schema change means updating both `schema.prisma` and the `lib/` files that touch the table (and `src/server/api.ts`). `lib/cron.mjs` is shared by both sides (typed by `lib/cron.d.mts`).
- **Runs start only through the CLI** (`tick`/`start` → detached `exec` → runner). The panel shells out to `bin/nightly start`/`run stop` and never spawns the runner itself, so restarting the panel cannot kill a run. `exec` strips `NODE_ENV`/`NEXT_*` from the runner's environment.
- **The panel process talks to SQLite only through Prisma** (better-sqlite3). Never open `node:sqlite` (or any second SQLite library) inside it: POSIX locks are per process, so closing that connection drops Prisma's locks, it believes it is the last one, and it deletes the WAL Prisma is writing to -- the panel's writes then vanish into a deleted file (2026-10-08). The CLI is a separate process and is fine.
- **Login** (optional, off by default) is settings `authEnabled`/`authUser`/`authHash`/`authSecret`, read by `src/server/auth.ts`; `setting.all` never returns the hash or secret and `setting.set` refuses the auth keys.
- Liveness constants are duplicated: `LIVE_MINUTES` in `lib/agents.mjs` and `src/lib/constants.ts`.
- **Dates are ISO-8601 text** in SQLite (what the Prisma adapter writes); the CLI writes `toISOString()`. Never write `CURRENT_TIMESTAMP`-style values, and never rely on a column's SQL default for a date (Prisma's `@default(now())` becomes `CURRENT_TIMESTAMP` in the table): the CLI always passes `now()`.
- **Priority** is per status list, lower = sooner, renumbered 10, 20, 30… on every move. Checks (`kind=check`) have their own list, separate from the queue.
- Enums are plain strings; the allowed values live in `lib/store.mjs` and `src/lib/constants.ts` — keep them in step.
- The nightly run appends **notes** (`nightly note`) rather than rewriting an item's body. Never delete items; close them as `done`/`wontfix`.
- `data/` is gitignored (the live DB). Test against a copy: `NIGHTLY_DB=/tmp/x.db bin/nightly …`.
- **This repository is meant to be public.** Everything specific to one workspace lives in the database (`data/`, gitignored): the run's prompts and the runner script are `Prompt` rows (Prompts tab, `nightly prompt`), never files here. `archive/` (screenshots, legacy files) is a separate, private, local-only Git repository nested inside it and gitignored: commit archive changes *inside* it, never in this one. Nothing that names a host, an email, a private repo's weakness or a token goes into this repository; host-specific values come from `.env` (`NIGHTLY_DEV_ORIGINS`, `NIGHTLY_DB`, `NIGHTLY_MEDIA`, `NIGHTLY_RUNNER`) or the `runner` setting.
- Checks before committing: `npm run typecheck && npm run build`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
