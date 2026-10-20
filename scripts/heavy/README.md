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

dev02 has 6 vCPUs and two build slots, so Godot suites queue there while two of Christian's machines sit idle: the always-on laptop "staging" (Ryzen 7 4800H, 16 threads, ~9 GB free, GTX 1660 Ti; 2 suite slots) and the desktop "staging02" (i7-8700K, 12 threads, 31 GB, RTX 2070; 4 slots, slower WiFi, off or in use at some weekends). The laptop is tried first; a box that does not answer is skipped for 5 minutes, and the desktop refuses suites while somebody is logged in at it. `HEAVY_OFFLOAD` in `/etc/heavy.conf` (set by `install.sh` on dev02 only) names a script that `heavy` calls from its wait loop, every `HEAVY_OFFLOAD_EVERY` seconds (15), as `<script> offer <command…>`. Exit 75 means "not taken" and the job keeps waiting; any other code is the job's own. It is offered only while waiting, never instead of a free slot, because each laptop core is slower than dev02's 13700K cores: the laptop adds throughput, not speed.

dev02's script is `~/godot/gpu.sh offer`. It takes only `./game.sh [--no-parse] [--timeout N] test [suites]` run from a project directory (anything else may need dev02's tunnels or dot-server-deploy), copies the project there with its addon links resolved, runs the suite under a 6 GB scope, streams the output and copies `.godot/test-logs/` back, so the caller cannot tell where it ran except for one "the laptop (staging) took this suite" line on stderr. A lost connection mid-run is a 75, so the job runs again here rather than reporting a result nobody saw. Suites and GPU jobs (bakes, frame timings) never share the laptop; `gpu.sh` explains the locks. `GPU_OFFLOAD=0` keeps one command local; `./gpu.sh status` shows the laptop's suite slots.

## Smoke runs wait for an empty board

`heavy` serialises the website smoke suite (`npm run test:smoke`, `npm run verify`, `playwright test`) but cannot make it rarer: with several agents each running it "as part of their own work", the runs went back to back and dev01 sat pegged for hours. Telling agents not to failed repeatedly, so it is enforced. A smoke-class command is refused while any other agent is live on the nightly board (not ended, seen within 60 minutes). The refusal names the active agents and tells the caller to verify with targeted tests in `heavy --lane check`, report "smoke not run (board busy)", and leave the one final pass to the orchestrator.

The rule lives in `heavy-smoke.py` and is enforced twice: by `heavy-gate.py` (also for commands already prefixed with `heavy`) and by `heavy` itself, so a script that skips the hook is still caught. It reads the board straight from `data/nightly.db` read-only, because the node CLI took minutes on a loaded VM. If the board cannot be read it fails open with a warning.

Overrides, as environment variables on the command: `HEAVY_SMOKE=final heavy -- npm run test:smoke` is the orchestrator's last pass and proceeds only when no other agent is live; `HEAVY_SMOKE=force` proceeds regardless and is for the user. `HEAVY_AGENT=<board name>` says which live agent is the caller; without it the caller is assumed to be one of the live agents, so two or more live agents block. Rerun `install.sh --remote x-tmc-dev02` after a change (dev02 has no nightly database, so there the gate fails open).

## Frames are drawn on a GPU box, not on dev02 (2026-10-20)

dev02 renders with llvmpipe, which hides distance problems and spends its memory. Before `heavy` takes any slot on dev02 it calls the offload script's `route` hook (`gpu.sh route <command>`), and exit 75 means "not taken, queue it here". Two rules:

- **Screenshot tools go to a real GPU first, always.** `tools/screenshot*.sh`, `tools/shot*.sh` and `game.sh shot`, run from a project directory (a leading `timeout N` or `env K=V` is looked through), become `gpu.sh shot`: copy the project (addon links resolved) to the laptop (GTX 1660 Ti) or else the desktop (RTX 2070), run the tool under Xvfb with `godot` and `xvfb-run` shimmed to add `--rendering-method forward_plus --rendering-driver vulkan --gpu-index <the NVIDIA card, found by name>`, and copy every new or changed `*.png` back to the same path. A shot takes `~/gpu/.lock` shared (like a suite) and one of two shot slots per box; a bake or frame timing (`gpu.sh run`, exclusive) keeps it out. With no box free for `GPU_SHOT_WAIT` (90 s), down, or a person at the desktop, it prints one `gpu.sh: WARN ... llvmpipe` line and heavy queues the tool locally as before. `GPU_OFFLOAD=0` skips the hook for one run. `RENDERER=gl_compatibility` and `--headless` runs are not given Vulkan flags.
- **A game suite goes to the boxes first** when `HEAVY_PREFER_OFFLOAD=1` or `/var/tmp/heavy/prefer-offload` is newer than 12 h. `scripts/run.sh` sets both for the nightly runner (the file on dev02, because its agents reach dev02 over ssh, which carries no environment, and removes it on exit). Otherwise a suite is offered only once it has waited, as before.

The map shots (`~/stack/zees-games/scripts/map-shot/run.sh`, run on dev01) go through `gpu.sh shot --stage/--pull` on dev02, so the frames are drawn on a box (`GAME_DIR=` keeps the old dev02 path). Other jobs: `gpu.sh run` (bakes, frame timings), `gpu.sh browser-shot` (WebGL on a real GPU) and `gpu.sh blender -- -b ...` (Blender 4.3 on the desktop).

**Why the 10-19 nightly suites queued for over an hour with both boxes idle:** the offer accepted only a command whose first word was `./game.sh`, and agents are told to write `heavy -- timeout 1400 ./game.sh ...`, so every one of those was "not a suite these boxes can run". `unwrap` in gpu.sh now peels `timeout` and `env`, and passes the timeout on as the remote limit. **The desktop's "somebody is using it" test** counted any `Remote=no` active user session; our ssh logins are `Remote=yes` and the manager session is `Class=manager`, so staging02 was not locked out by them (checked 2026-10-20), but the test now also needs a seat (a graphical or console login), so a stray local session of ours cannot lock it out later.

Not wired, for later: Godot imports and `--check-only` (cheap on dev02, the copy costs more), lightmap bakes in `game.sh` (run them with `gpu.sh run <project> --script ...`), a nightly Blender batch (use `gpu.sh blender`), Playwright browser checks of the web client (`gpu.sh cdp` tunnels a GPU Chrome to localhost; they would need `browser-shot` extended to a script).
