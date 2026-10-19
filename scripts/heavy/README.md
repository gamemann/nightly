# Memory guard: `heavy`, its hook, and the per-VM ceilings

x-tmc-dev01 kept "shutting off" in virt-manager. Each time, parallel agents (a nightly fan-out,
an orchestrator) were running `next build`, smoke suites and Godot suites at once. The guest
filled its RAM, the host ran short, and the host killed the VM's qemu process. Inside the
guest that looks like a journal that just stops: no panic and no shutdown. The old rule
("check nothing heavy is running first") was a race that every agent won at the same moment.
This directory replaces it with three things that do not depend on an agent remembering:

| Piece | What it does |
| --- | --- |
| `heavy` → `/usr/local/bin/heavy` | Per-VM queue. `build` lane: 1 slot on dev01, 2 on dev02 (next build, smoke, verify, Playwright, Godot suites and imports, cargo/docker builds). `check` lane: 2 slots (tsc, `npm run check`/lint, `npm test`, `godot --check-only`). It also waits for `HEAVY_MIN_AVAIL_GB` free before starting. `heavy --status` shows who holds the slots. |
| per-job scope | `heavy` runs each job in its own `systemd-run --user --scope` with `MemoryMax=HEAVY_JOB_MAX_GB` and no swap. The slice's `MemoryHigh` only *throttles*: a 17.7 GB smoke-run dev server stayed under it and swapped dev01 for 15 minutes (2026-10-16). A job over its ceiling is killed and `heavy` says so (exit 137). Skipped when the user bus is unreachable. |
| `heavy-gate.py` → `~/.claude/hooks/` | PreToolUse hook on Bash that refuses those commands unless they are prefixed with `heavy`, and prints the exact rewrite. It covers every session and sub-agent on the VM, nightly included. `HEAVY_GATE=off` turns it off for one session. |
| `user-1000.slice` `MemoryHigh`/`MemoryMax` | A hard ceiling on everything the `christian` user runs. A job that overshoots is OOM-killed inside the guest, and the VM survives. Postgres, ClickHouse, Redis and Docker are outside the ceiling. ClickHouse is capped separately, because its default is 90% of RAM. |

The budgets (in `install.sh`): dev01 (31 GB) High 20G / Max 22G, 18 GB per job (a cold `next build` peaks at 15.7 GB), ClickHouse 5 GB,
5 GB free to start a job; dev02 (12 GB) High 8G / Max 9G, 7 GB per job, 3 GB free to start a job, and a second build slot that is taken only while 5 GB is free (`HEAVY_EXTRA_AVAIL_GB`). Why 5: dev02 Godot suites peak at 0.5 GB median, 2 GB p99, 3.5 GB worst over 1010 jobs, and 4 to 7 GB was free through 2026-10-18 with one slot. The check is at acquisition and the slot is let go when it fails, so a waiting job takes slot 1 the moment it frees. If a pair still overshoots, the user slice kills one job (exit 137), not the VM.
One job needing more sets `HEAVY_JOB_MAX_GB=<n> heavy -- …` for that run: a `HEAVY_*` in the
environment wins over `/etc/heavy.conf`, which only holds the VM's defaults.

Install or update: `scripts/heavy/install.sh` on dev01, which symlinks so edits here are live,
then `scripts/heavy/install.sh --remote x-tmc-dev02`, which copies, so rerun it after a change.

The ceilings only bound what a guest touches. They do not fix a host that has promised more
RAM to its guests than it has. That sum has to fit the host's physical RAM with a few GB to
spare; nothing in the guests can enforce it.

sysstat samples every minute on both VMs (`sar -r -f /var/log/sysstat/saDD`), so the next
incident leaves a memory trace.

## Offload: dev02's waiting suites go to the laptop

dev02 has 6 vCPUs and two build slots, so Godot suites queue there while Christian's always-on laptop "staging" (Ryzen 7 4800H, 16 threads, ~9 GB free, the GTX 1660 Ti box) sits idle. `HEAVY_OFFLOAD` in `/etc/heavy.conf` (set by `install.sh` on dev02 only) names a script that `heavy` calls from its wait loop, every `HEAVY_OFFLOAD_EVERY` seconds (15), as `<script> offer <command…>`. Exit 75 means "not taken" and the job keeps waiting; any other code is the job's own. It is offered only while waiting, never instead of a free slot, because each laptop core is slower than dev02's 13700K cores: the laptop adds throughput, not speed.

dev02's script is `~/godot/gpu.sh offer`. It takes only `./game.sh [--no-parse] [--timeout N] test [suites]` run from a project directory (anything else may need dev02's tunnels or dot-server-deploy), copies the project there with its addon links resolved, runs the suite under a 6 GB scope, streams the output and copies `.godot/test-logs/` back, so the caller cannot tell where it ran except for one "the laptop (staging) took this suite" line on stderr. A lost connection mid-run is a 75, so the job runs again here rather than reporting a result nobody saw. Suites and GPU jobs (bakes, frame timings) never share the laptop; `gpu.sh` explains the locks. `GPU_OFFLOAD=0` keeps one command local; `./gpu.sh status` shows the laptop's suite slots.

## Smoke runs wait for an empty board

`heavy` serialises the website smoke suite (`npm run test:smoke`, `npm run verify`, `playwright test`) but cannot make it rarer: with several agents each running it "as part of their own work", the runs went back to back and dev01 sat pegged for hours. Telling agents not to failed repeatedly, so it is enforced. A smoke-class command is refused while any other agent is live on the nightly board (not ended, seen within 60 minutes). The refusal names the active agents and tells the caller to verify with targeted tests in `heavy --lane check`, report "smoke not run (board busy)", and leave the one final pass to the orchestrator.

The rule lives in `heavy-smoke.py` and is enforced twice: by `heavy-gate.py` (also for commands already prefixed with `heavy`) and by `heavy` itself, so a script that skips the hook is still caught. It reads the board straight from `data/nightly.db` read-only, because the node CLI took minutes on a loaded VM. If the board cannot be read it fails open with a warning.

Overrides, as environment variables on the command: `HEAVY_SMOKE=final heavy -- npm run test:smoke` is the orchestrator's last pass and proceeds only when no other agent is live; `HEAVY_SMOKE=force` proceeds regardless and is for the user. `HEAVY_AGENT=<board name>` says which live agent is the caller; without it the caller is assumed to be one of the live agents, so two or more live agents block. Rerun `install.sh --remote x-tmc-dev02` after a change (dev02 has no nightly database, so there the gate fails open).
