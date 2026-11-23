The redesign is tracked in phases; the brief is [redesign-plan.md](./redesign-plan.md). This page lists what each phase delivered and where the next one hooks in. Search the code for `EXTENSION POINT` to find the marked hooks.

## Phase 1: foundation (done)

- **Accounts.** Users, roles, per-user grants, DB sessions, login with rate limiting, CSRF same-origin check, permission-checked tRPC routers (`ROUTER_PERMS`, `permProcedure`), page guards, permission-hidden sidebar. The bootstrap migrates the old single login into an admin user. CLI: `nightly user|role|folder|project|access|node|dbconn|build`.
- **Shell.** Night theme (starfield, moon), collapsible responsive sidebar, sections Transcripts, Projects, Tasks, Automation, Usage, Game Tools, Account, AdminCP. Home is the RSI board. Old URLs redirect (`next.config.ts`).
- **Projects.** `/projects`: folder tree, search, type and archived filters, new folder and project forms. `/projects/<slug>/<tab>`: overview with edit and delete, tasks, perf, builds, settings with icon upload. Access per project or folder (`ProjectAccess`) inherits down the tree.
- **Account.** `/account/settings`: name, password change, sessions, sign out others.
- **AdminCP.** Users (roles, grants, disable, delete; the last enabled admin cannot be removed) and Roles (permission grid by area, patterns). Nodes, Communication, Databases and Builds pages come from the node work (`nodeOps` router).
- **Transcripts.** The section shell and sidebar entry; the transcript reader, new chat and agents pages came with phase 2 (`src/app/transcripts/`).
- **Tests.** `lib/permissions.test.mjs` (password hashing, legacy hashes, permission resolution, project access inheritance, folder tree, router permissions), `lib/bootstrap.test.mjs`, `lib/icons.test.mjs`.

## Scaffolds waiting for later phases

| Page | Phase | Hook |
|---|---|---|
| `/automation/workflows` | 3 | `src/components/later/Workflows.tsx` |
| `/admin/crashlog`, `/tools/map-converter` | 4 | `src/components/later/` |
| Project tabs assets, maps, crashes, playtest | 4 | `TABS` in `src/app/projects/[slug]/[[...tab]]/page.tsx` |

## Adding to the panel

- A new page: put it under its section in `src/app/`, call `guard('<perm>')` first, and add a sidebar entry with the same `perm` in `src/lib/nav.ts`.
- A new permission: add it to `PERMISSIONS` in `lib/permissions.mjs` (and to a default role if everyone should have it). The Roles page picks it up.
- A new router: register it in `src/server/api.ts` and give it a base permission in `ROUTER_PERMS`; routers without one need only a session, so guard each procedure with `permProcedure` or `assertProject`.
- A new project tab: add a row to `TABS` with its permission; the tab reads the project the page already loaded.
