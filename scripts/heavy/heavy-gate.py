#!/usr/bin/env python3
"""PreToolUse gate on Bash: memory-hungry commands must go through `heavy`.

Parallel agents each ran `next build`, the smoke suite or a Godot suite at the same moment,
the guest filled its RAM and the host killed the VM (x-tmc-dev01, 2026-10-16). `heavy` queues
them per VM; this hook refuses one that skips the queue, with exit 2 so the agent sees the
reason and the exact command to run instead.

Each `&&`/`||`/`;`/`|`/newline segment is looked at on its own, with its command-position
prefixes (env assignments, sudo, timeout N, nice, time, ssh host, bash -c, do/then) stripped,
so `grep "next build"` or a commit message naming one never trips it. A command that starts
with `heavy` passes whole, so `heavy -- bash -c 'for ...; do godot ...; done'` is fine.
HEAVY_GATE=off in the environment turns the gate off for a session.

Smoke-class commands (test:smoke, verify, playwright test) are held to a second rule, even when
they are prefixed with `heavy`: they are refused while any other agent is live on the nightly
board (heavy-smoke.py has the rule, the overrides HEAVY_SMOKE=final|force, and why).
"""
import importlib.util, json, os, re, sys

def _smoke_module():
    # Next to this file; resolve the symlink so the repo copy is found where installed by link.
    here = os.path.dirname(os.path.realpath(__file__))
    spec = importlib.util.spec_from_file_location("heavy_smoke", os.path.join(here, "heavy-smoke.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

BUILD = [
    r"next\s+build\b",
    r"npm\s+run\s+(build|build:safe|test:smoke|verify|desktop)(\s|$)",
    r"npm\s+run\s+tauri\s+(--\s+)?build\b",
    r"(tauri|cargo\s+tauri)\s+build\b",
    r"playwright\s+test\b",
    r"(\S*/)?game\.sh\s+(test|shot|server)\b",
    r"(\S*/)?godot[\w.-]*\s(?!.*--check-only).*--headless",
    r"(\S*/)?godot[\w.-]*\s+--headless(?!.*--check-only)",
    r"docker\s+(compose\s+)?build\b",
    r"docker\s+compose\s+up\b.*--build",
    r"(\./)?(build|deploy)\.sh\b",
    r"cargo\s+(build|test|clippy)\b",
    r"(bash\s+)?scripts/cargo\.sh\s+(build|test|clippy)\b",
]
CHECK = [
    r"npm\s+run\s+(check|check:web|check:rust|typecheck|lint)(\s|$)",
    r"npm\s+(run\s+)?test(\s|$)",
    r"tsc(\s|$)",
    r"(\S*/)?godot[\w.-]*\s.*--check-only",
]

PREFIX = re.compile(
    r"""^(?:
        [\s(){}'"]+ | \$\( |
        \w+=(?:'[^']*'|"[^"]*"|\S*)\s+ |
        (?:sudo|exec|time|env|command|do|then|else|xargs)\s+(?:-\S+\s+)* |
        nice\s+(?:-n\s*\S+\s+|-\d+\s+)? |
        ionice\s+(?:-\S+\s+)* |
        timeout\s+(?:-[ks]\s*\S+\s+|-\S+\s+)*\S+\s+ |
        npx\s+(?:--yes\s+|-y\s+)? |
        (?:ba|z)?sh\s+-\w*c\s+ |
        ssh\s+(?:-[iopFlJLRDS]\s*\S+\s+|-\w+\s+)*[^\s-]\S*\s+
    )""", re.X)

def strip(seg):
    while True:
        m = PREFIX.match(seg)
        if not m or not m.group(0):
            return seg
        seg = seg[m.end():]

def lane_of(cmd):
    for p in CHECK:
        if re.match(p, cmd):
            return "check"
    for p in BUILD:
        if re.match(p, cmd):
            return "build"
    return None

HEAVY_PREFIX = re.compile(r"heavy(\s+--lane[=\s]\s*\w+)?(\s+--)?\s+")

def smoke_refusal(command):
    """The board message when a smoke-class segment may not run now, else None. Fails open."""
    try:
        hs = _smoke_module()
        smoke = False
        for seg in re.split(r"&&|\|\||;|\||\n", command):
            cmd = strip(seg)
            m = HEAVY_PREFIX.match(cmd)
            # Under `heavy`, the rest is its argv and may be a `bash -c` body: search it.
            smoke = smoke or (hs.is_smoke(cmd[m.end():], anchored=False) if m else hs.is_smoke(cmd))
        if not smoke:
            return None
        # The mode may be set in the command itself (`HEAVY_SMOKE=final heavy -- ...`).
        mm = re.search(r"\bHEAVY_SMOKE=(\w+)", command)
        am = re.search(r"\bHEAVY_AGENT=([\w.-]+)", command)
        ok, msg = hs.decide(mm.group(1) if mm else os.environ.get("HEAVY_SMOKE", ""),
                            am.group(1) if am else os.environ.get("HEAVY_AGENT", ""))
        if ok and msg:  # a warning, such as the board being unreadable
            sys.stderr.write(msg + "\n")
        return None if ok else msg
    except Exception as e:  # noqa: BLE001 - a broken gate must not block work
        sys.stderr.write("heavy-gate: smoke check failed open (%s)\n" % e)
        return None

def main():
    if os.environ.get("HEAVY_GATE", "").lower() in ("off", "0", "false"):
        return 0
    data = json.load(sys.stdin)
    if data.get("tool_name") != "Bash":
        return 0
    command = (data.get("tool_input") or {}).get("command") or ""
    refusal = smoke_refusal(command)
    if refusal:
        sys.stderr.write(refusal)
        return 2
    if re.match(r"heavy(\s|$)", strip(command)):
        return 0
    hits = []
    for seg in re.split(r"&&|\|\||;|\||\n", command):
        cmd = strip(seg)
        if re.match(r"heavy(\s|$)", cmd):
            continue
        lane = lane_of(cmd)
        if lane:
            hits.append((lane, cmd.strip().rstrip("'\")")))
    if not hits:
        return 0
    lines = "\n".join(
        "  heavy %s-- %s" % ("--lane check " if lane == "check" else "", cmd) for lane, cmd in hits)
    sys.stderr.write(
        "Refused: this runs a memory-hungry command outside the queue. Parallel agents doing "
        "that filled the VM's RAM and the host killed x-tmc-dev01. Prefix it with `heavy` on "
        "the machine that runs it (inside the quotes for ssh):\n%s\n"
        "`heavy` waits for a free slot (build lane: one build/smoke/verify/Playwright/Godot "
        "suite per VM; check lane: two tsc/check/test runs) and for free memory, then runs the "
        "command unchanged. A long wait or run belongs in run_in_background. "
        "`heavy --status` shows who holds the slots. Do not work round the queue.\n" % lines)
    return 2

if __name__ == "__main__":
    sys.exit(main())
