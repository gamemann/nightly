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
| `heavy-gate.py` → `~/.claude/hooks/` | PreToolUse hook on Bash that refuses those commands unless they are prefixed with `heavy`, and prints the exact rewrite. It covers every session and sub-agent on the VM, nightly included. `HEAVY_GATE=off` turns it off for one session. |
| `user-1000.slice` `MemoryHigh`/`MemoryMax` | A hard ceiling on everything the `christian` user runs. A job that overshoots is OOM-killed inside the guest, and the VM survives. Postgres, ClickHouse, Redis and Docker are outside the ceiling. ClickHouse is capped separately, because its default is 90% of RAM. |

The budgets (in `install.sh`): dev01 (38 GB) High 26G / Max 28G, ClickHouse 6 GB, 6 GB free to
start a job; dev02 (12 GB) High 8G / Max 9G, 3 GB free to start a job.

Install or update: `scripts/heavy/install.sh` on dev01, which symlinks so edits here are live,
then `scripts/heavy/install.sh --remote x-tmc-dev02`, which copies, so rerun it after a change.

The ceilings only bound what a guest touches. They do not fix a host that has promised more
RAM to its guests than it has. That sum has to fit the host's physical RAM with a few GB to
spare; nothing in the guests can enforce it.

sysstat samples every minute on both VMs (`sar -r -f /var/log/sysstat/saDD`), so the next
incident leaves a memory trace.
