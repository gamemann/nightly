#!/usr/bin/env python3
"""Smoke gate: full-suite runs (smoke, verify, Playwright) only when no other agent is live.

Shared by heavy-gate.py (the PreToolUse hook) and `heavy` (the wrapper, so a script that
skips the hook is still caught). Several agents each running the website smoke suite kept
dev01 pegged for an hour at a time, because `heavy` only serialises them: it does not make
them fewer. The rule is that the suite runs once, at the end, when the board is empty.

The board is read straight from nightly's SQLite file (read-only) rather than through
`nightly agent board`: the node CLI took minutes on a loaded dev01, and a gate that is
slower than the thing it gates gets bypassed. "Live" is the board's own definition: not
ended and seen within 60 minutes (lib/agents.mjs LIVE_MINUTES).

  HEAVY_SMOKE=final   proceeds only if no other agent is live (the orchestrator's last pass)
  HEAVY_SMOKE=force   proceeds regardless (for the user)
  HEAVY_AGENT=<name>  the caller's own board name, excluded from "other". Unset, the caller
                      is assumed to be one live agent, so more than one live agent blocks.
If the board cannot be read the gate fails open with a warning, never blocks forever.

CLI: heavy-smoke.py check [--mode M] [--self NAME]   exit 0 ok, 2 refused (message on stderr)
     heavy-smoke.py is-smoke <command...>            exit 0 if the command is smoke-class
"""
import datetime, os, re, sqlite3, sys

SMOKE = [
    r"npm\s+run\s+(test:smoke|verify)(\s|$)",
    r"playwright\s+test\b",
]
DB = os.environ.get("NIGHTLY_DB") or os.path.expanduser("~/stack/nightly/data/nightly.db")
LIVE_MINUTES = 60

def is_smoke(cmd, anchored=True):
    f = re.match if anchored else re.search
    return any(f(p, cmd) for p in SMOKE)

def live_agents():
    """[(name, task)] of live agents. Raises on any read problem."""
    c = sqlite3.connect("file:%s?mode=ro" % DB, uri=True, timeout=2)
    try:
        rows = c.execute("SELECT name, task, lastSeenAt FROM Agent WHERE endedAt IS NULL").fetchall()
    finally:
        c.close()
    now = datetime.datetime.now(datetime.timezone.utc)
    out = []
    for name, task, seen in rows:
        t = datetime.datetime.fromisoformat(seen.replace("Z", "+00:00"))
        if t.tzinfo is None:
            t = t.replace(tzinfo=datetime.timezone.utc)
        if (now - t).total_seconds() < LIVE_MINUTES * 60:
            out.append((name, task or ""))
    return out

def decide(mode="", me="", agents=None):
    """(ok, message). message is a refusal when not ok, a warning (or "") when ok."""
    mode = (mode or "").lower()
    if mode == "force":
        return True, ""
    try:
        agents = live_agents() if agents is None else agents
    except Exception as e:  # noqa: BLE001 - any failure must fail open
        return True, "heavy: smoke gate could not read the agent board (%s); allowing the run." % e
    if me:
        others = [a for a in agents if a[0] != me]
    else:
        # Unknown caller: assume it is one of the live agents, and name them all.
        others = agents if len(agents) > 1 else []
    if not others:
        return True, ""
    names = "\n".join("  %s: %s" % (n, t[:80]) for n, t in others)
    return False, (
        "Refused: smoke, verify and Playwright runs wait until every other agent on the board is "
        "done. Several agents each running the suite kept x-tmc-dev01 pegged for an hour at a "
        "time. Active on the board now:\n%s\n"
        "Do NOT run smoke now. Verify with targeted unit tests in `heavy --lane check -- ...` "
        "(tsc, npm run check, the single test file), report \"smoke not run (board busy)\", and "
        "leave the final smoke pass to the orchestrator once the board is empty "
        "(`HEAVY_SMOKE=final heavy -- npm run test:smoke`). Do not work round this gate.\n" % names)

def main(argv):
    if len(argv) >= 2 and argv[1] == "is-smoke":
        return 0 if is_smoke(" ".join(argv[2:]), anchored=False) else 1
    if len(argv) >= 2 and argv[1] == "check":
        mode, me = os.environ.get("HEAVY_SMOKE", ""), os.environ.get("HEAVY_AGENT", "")
        a = argv[2:]
        while a:
            if a[0] == "--mode": mode = a[1]
            elif a[0] == "--self": me = a[1]
            a = a[2:]
        ok, msg = decide(mode, me)
        if msg:
            sys.stderr.write(msg + ("" if msg.endswith("\n") else "\n"))
        return 0 if ok else 2
    sys.stderr.write(__doc__)
    return 64

if __name__ == "__main__":
    sys.exit(main(sys.argv))
