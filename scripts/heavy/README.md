# Memory guard: `heavy`, its hook, and the per-VM ceilings

A development VM kept dying. Each time, parallel agents (a nightly fan-out, an orchestrator)
were running `next build`, smoke suites and game-engine suites at once. The guest filled its
RAM, the host ran short, and the host killed the VM's qemu process. Inside the guest that
looks like a journal that just stops: no panic and no shutdown. "Check nothing heavy is
running first" is a race that every agent wins at the same moment. This directory replaces
it with things that do not depend on an agent remembering:

| Piece | What it does |
| --- | --- |
| `heavy` → `/usr/local/bin/heavy` | Per-VM queue. `build` lane: `HEAVY_SLOTS_BUILD` slots (next build, smoke, verify, Playwright, game-engine suites and imports, cargo/docker builds). `check` lane: 2 slots (tsc, `npm run check`/lint, `npm test`, `godot --check-only`). It also waits for `HEAVY_MIN_AVAIL_GB` free before starting. `heavy --status` shows who holds the slots. |
| per-job scope | `heavy` runs each job in its own `systemd-run --user --scope` with `MemoryMax=HEAVY_JOB_MAX_GB` and no swap. The slice's `MemoryHigh` only *throttles*, so a huge dev server can stay under it and swap the VM for minutes. The ceiling is also held under the memory free at start less `HEAVY_JOB_HEADROOM_GB` (3). |
| `heavy-gate.py` → `~/.claude/hooks/` | PreToolUse hook on Bash that refuses those commands unless they are prefixed with `heavy`, and prints the exact rewrite. It covers every session and sub-agent on the VM. `HEAVY_GATE=off` turns it off for one session. |
| `user-1000.slice` `MemoryHigh`/`MemoryMax` | A hard ceiling on everything the user runs. A job that overshoots is OOM-killed inside the guest, and the VM survives. Databases and Docker are outside the ceiling. ClickHouse, if present, is capped separately, because its default is 90% of RAM. |

One job needing more sets `HEAVY_JOB_MAX_GB=<n> heavy -- …` for that run: a `HEAVY_*` in the
environment wins over `/etc/heavy.conf`, which only holds the VM's defaults.

## Install

`scripts/heavy/install.sh` on the machine that holds this repository (it symlinks, so edits
here are live); `scripts/heavy/install.sh --remote HOST [KEY]` copies to another VM (rerun
after a change; the key defaults to `$HEAVY_SSH_KEY`, else `~/.ssh/id_ed25519`).

Budgets default from the machine's RAM (High = 2/3, Max = 3/4, per-job = 1/2, 3 GB free to
start a job, a second build slot below 24 GB that is taken only while `HEAVY_EXTRA_AVAIL_GB`
(5) is free). Per host overrides go in `~/.config/heavy/budgets` (or `$HEAVY_BUDGETS`), one
line per host: `hostname high max avail job clickhouse_bytes builds extra offload_script`,
`-` for none. The file is yours and is not in this repository.

The ceilings only bound what a guest touches. They do not fix a host that has promised more
RAM to its guests than it has; nothing in the guests can enforce that.

## Offload

If `HEAVY_OFFLOAD` (set in `/etc/heavy.conf` from the budgets file) names a script, `heavy`
offers a waiting job to it: `script offer <command>` may run it elsewhere (another machine
with free slots), and `script route <command>` is asked before any slot is taken. Exit 75
means "not taken, run it here". With `HEAVY_PREFER_OFFLOAD=1` an eligible job is offered
before it queues locally. `HEAVY_PREFER_OFFLOAD=0` opts out. The script is your own; none
is shipped.

## Smoke runs wait for an empty board

`heavy` serialises the website smoke suite (`npm run test:smoke`, `npm run verify`,
`playwright test`) but cannot make it rarer: with several agents each running it, the runs
went back to back and the VM sat pegged for hours. So a smoke-class command is refused while
any other agent is live on the nightly board. The rule lives in `heavy-smoke.py` and is
enforced by `heavy-gate.py` (also for commands already prefixed with `heavy`) and by `heavy`
itself. It reads the board read-only from `data/nightly.db`; if the board cannot be read it
fails open with a warning.

Overrides, as environment variables on the command: `HEAVY_SMOKE=final heavy -- npm run
test:smoke` is the orchestrator's last pass and proceeds only when no other agent is live;
`HEAVY_SMOKE=force` proceeds regardless and is for the user. `HEAVY_AGENT=<board name>` says
which live agent is the caller; without it two or more live agents block.

## Waiting never holds a slot

A job takes a slot only once the memory for it is free (`HEAVY_MIN_AVAIL_GB`, and
`HEAVY_EXTRA_AVAIL_GB` for build slots after the first); until then it holds nothing, so
`heavy --status` shows only running jobs. `--max-wait SECONDS` / `HEAVY_MAX_WAIT` (default 0
= forever) makes a waiter give up. Waiters are FIFO; a non-head waiter also offers to the
offload script every `HEAVY_OFFLOAD_EVERY` seconds. A job is stopped after
`HEAVY_JOB_MAX_MIN` minutes (45). The source in this directory is the only copy: change it
here and rerun `install.sh`; never edit `/usr/local/bin/heavy`.
