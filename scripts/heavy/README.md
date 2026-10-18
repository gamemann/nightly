# Memory guard: `heavy`, its hook, and the per-VM ceilings

x-tmc-dev01 kept "shutting off" in virt-manager. Each time, parallel agents (a nightly fan-out,
an orchestrator) were running `next build`, smoke suites and Godot suites at once. The guest
filled its RAM, the host ran short, and the host killed the VM's qemu process. Inside the
guest that looks like a journal that just stops: no panic and no shutdown. The old rule
("check nothing heavy is running first") was a race that every agent won at the same moment.
This directory replaces it with three things that do not depend on an agent remembering:

| Piece | What it does |
| --- | --- |
| `heavy` → `/usr/local/bin/heavy` | Per-VM queue. `build` lane: 1 slot (next build, smoke, verify, Playwright, Godot suites and imports, cargo/docker builds). `check` lane: 2 slots (tsc, `npm run check`/lint, `npm test`, `godot --check-only`). It also waits for `HEAVY_MIN_AVAIL_GB` free before starting. `heavy --status` shows who holds the slots. |
| per-job scope | `heavy` runs each job in its own `systemd-run --user --scope` with `MemoryMax=HEAVY_JOB_MAX_GB` and no swap. The slice's `MemoryHigh` only *throttles*: a 17.7 GB smoke-run dev server stayed under it and swapped dev01 for 15 minutes (2026-10-16). A job over its ceiling is killed and `heavy` says so (exit 137). Skipped when the user bus is unreachable. |
| `heavy-gate.py` → `~/.claude/hooks/` | PreToolUse hook on Bash that refuses those commands unless they are prefixed with `heavy`, and prints the exact rewrite. It covers every session and sub-agent on the VM, nightly included. `HEAVY_GATE=off` turns it off for one session. |
| `user-1000.slice` `MemoryHigh`/`MemoryMax` | A hard ceiling on everything the `christian` user runs. A job that overshoots is OOM-killed inside the guest, and the VM survives. Postgres, ClickHouse, Redis and Docker are outside the ceiling. ClickHouse is capped separately, because its default is 90% of RAM. |

The budgets (in `install.sh`): dev01 (31 GB) High 20G / Max 22G, 18 GB per job (a cold `next build` peaks at 15.7 GB), ClickHouse 5 GB,
5 GB free to start a job; dev02 (12 GB) High 8G / Max 9G, 7 GB per job, 3 GB free to start a job.
One job needing more sets `HEAVY_JOB_MAX_GB=<n> heavy -- …` for that run: a `HEAVY_*` in the
environment wins over `/etc/heavy.conf`, which only holds the VM's defaults.

Install or update: `scripts/heavy/install.sh` on dev01, which symlinks so edits here are live,
then `scripts/heavy/install.sh --remote x-tmc-dev02`, which copies, so rerun it after a change.

The ceilings only bound what a guest touches. They do not fix a host that has promised more
RAM to its guests than it has. That sum has to fit the host's physical RAM with a few GB to
spare; nothing in the guests can enforce it.

sysstat samples every minute on both VMs (`sar -r -f /var/log/sysstat/saDD`), so the next
incident leaves a memory trace.

## Smoke runs wait for an empty board

`heavy` serialises the website smoke suite (`npm run test:smoke`, `npm run verify`, `playwright test`) but cannot make it rarer: with several agents each running it "as part of their own work", the runs went back to back and dev01 sat pegged for hours. Telling agents not to failed repeatedly, so it is enforced. A smoke-class command is refused while any other agent is live on the nightly board (not ended, seen within 60 minutes). The refusal names the active agents and tells the caller to verify with targeted tests in `heavy --lane check`, report "smoke not run (board busy)", and leave the one final pass to the orchestrator.

The rule lives in `heavy-smoke.py` and is enforced twice: by `heavy-gate.py` (also for commands already prefixed with `heavy`) and by `heavy` itself, so a script that skips the hook is still caught. It reads the board straight from `data/nightly.db` read-only, because the node CLI took minutes on a loaded VM. If the board cannot be read it fails open with a warning.

Overrides, as environment variables on the command: `HEAVY_SMOKE=final heavy -- npm run test:smoke` is the orchestrator's last pass and proceeds only when no other agent is live; `HEAVY_SMOKE=force` proceeds regardless and is for the user. `HEAVY_AGENT=<board name>` says which live agent is the caller; without it the caller is assumed to be one of the live agents, so two or more live agents block. Rerun `install.sh --remote x-tmc-dev02` after a change (dev02 has no nightly database, so there the gate fails open).
