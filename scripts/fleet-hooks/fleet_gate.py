#!/usr/bin/env python3
"""Fleet guards, run by Claude Code as PreToolUse hooks. Sub-agents only (the hook input has agent_id); the lead
session is never gated.

    fleet_gate.py poll   (matcher Bash)  fleet-no-poll-hook-1: polling cost 22% of sub-agent tokens 2026-11-12..19.
        Refuses: a sleep of poll_sleep_max seconds or more in one call (sum of the call's sleeps); a while/until/for loop
        that sleeps and is not bounded by `timeout N`; a sleep run in the background; a status poll (gh run
        list/view without --log, heavy --status) after poll_status_max of them in this agent.
    fleet_gate.py cap    (matcher *)     fleet-zero-commit-cap-1: 21% of tokens went to agents that committed nothing.
        Counts tool calls since the agent's last `git commit`. At commit_cap the call is refused once with a report
        demand, then once every commit_cap_repeat calls; from 2 x commit_cap every call is refused except git,
        nightly and the hand-back, so the agent commits or reports.

Configuration: ~/.claude/fleet-hooks.json {"poll_sleep_max": 20, "poll_status_max": 3, "commit_cap": 150,
"commit_cap_repeat": 25}, overridden by the environment FLEET_POLL_SLEEP_MAX, FLEET_POLL_STATUS_MAX, FLEET_COMMIT_CAP,
FLEET_COMMIT_CAP_REPEAT. 0 turns a guard off. A bad value is refused loudly (exit 2, names the setting); a crash of
the hook itself exits 1 with the traceback (shown, not blocking). State: ~/.claude/fleet-hooks-state/<agent_id>.json.
Versioned in nightly scripts/fleet-hooks (tests: test_fleet_gate.py); installed as a symlink in ~/.claude/hooks.
"""
import fcntl
import json
import os
import re
import sys
import time
import traceback

DEFAULTS = {"poll_sleep_max": 20, "poll_status_max": 3, "commit_cap": 150, "commit_cap_repeat": 25}
HOME = os.path.expanduser("~")
CONFIG = os.environ.get("FLEET_HOOKS_CONFIG", os.path.join(HOME, ".claude", "fleet-hooks.json"))
STATE = os.environ.get("FLEET_HOOKS_STATE", os.path.join(HOME, ".claude", "fleet-hooks-state"))

ALTERNATIVE = ("Instead: run the thing you are waiting for as ONE blocking command with a timeout "
               "(timeout 900 <cmd>, or timeout 600 bash -c 'until <ready>; do sleep 5; done'), "
               "`gh run watch <id> --exit-status` once, `heavy run` (it blocks), or the Monitor tool; "
               "or run it with run_in_background and wait for the completion notice without checking on it.")


class ConfigError(Exception):
    pass


def config():
    c = dict(DEFAULTS)
    if os.path.exists(CONFIG):
        try:
            with open(CONFIG) as fh:
                user = json.load(fh)
        except (OSError, ValueError) as e:
            raise ConfigError("%s is not valid JSON: %s" % (CONFIG, e))
        if not isinstance(user, dict):
            raise ConfigError("%s must be a JSON object" % CONFIG)
        for k, v in user.items():
            if k not in DEFAULTS:
                raise ConfigError("%s: unknown setting %r (known: %s)" % (CONFIG, k, ", ".join(DEFAULTS)))
            c[k] = v
    for k in DEFAULTS:
        e = "FLEET_" + k.upper()
        if os.environ.get(e, "") != "":
            c[k] = os.environ[e]
    for k, v in c.items():
        try:
            n = int(v)
        except (TypeError, ValueError):
            raise ConfigError("fleet hook setting %s=%r is not a whole number (0 = off)" % (k, v))
        if n < 0 or isinstance(v, bool) or (isinstance(v, float) and v != n):
            raise ConfigError("fleet hook setting %s=%r must be a whole number >= 0 (0 = off)" % (k, v))
        c[k] = n
    return c


class State:
    """Per-agent counters, locked so parallel tool calls of one agent do not lose counts."""

    def __init__(self, agent):
        os.makedirs(STATE, exist_ok=True)
        self.path = os.path.join(STATE, re.sub(r"[^\w.-]", "_", agent) + ".json")

    def __enter__(self):
        self.fh = open(self.path, "a+")
        fcntl.flock(self.fh, fcntl.LOCK_EX)
        self.fh.seek(0)
        try:
            self.data = json.loads(self.fh.read() or "{}")
        except ValueError:
            self.data = {}
        return self.data

    def __exit__(self, *exc):
        self.data["seen"] = time.time()
        self.fh.seek(0)
        self.fh.truncate()
        json.dump(self.data, self.fh)
        self.fh.close()


def prune():
    """Drop state of agents silent for two days (agent ids are never reused)."""
    try:
        cut = time.time() - 2 * 86400
        for n in os.listdir(STATE):
            p = os.path.join(STATE, n)
            if os.path.getmtime(p) < cut:
                os.remove(p)
    except OSError:
        pass


SECONDS = {"": 1, "s": 1, "m": 60, "h": 3600, "d": 86400}


def sleeps(cmd):
    """Seconds slept by the sleep commands of cmd (each argument of sleep is added, like sleep itself does)."""
    total = 0.0
    for m in re.finditer(r"(?:^|[;&|(`{\s]|\$\()sleep((?:\s+[0-9.]+[smhd]?)+)", cmd):
        for a in m.group(1).split():
            n = re.match(r"([0-9.]+)([smhd]?)$", a)
            if n:
                try:
                    total += float(n.group(1)) * SECONDS[n.group(2)]
                except ValueError:
                    pass
    return total


def loop_sleeps(cmd):
    """A while/until/for loop with a sleep in its body (a poll), and whether a `timeout N` bounds it."""
    if not re.search(r"(?:^|[;&|({\s])(while|until|for)\s.*?\bdo\b(?:(?!\bdone\b).)*?\bsleep\b", cmd, re.S):
        return False, False
    bounded = re.search(r"(?:^|[;&|(\s])timeout\s+(?:-\S+\s+)*[0-9.]+[smhd]?\s+(?:bash|sh)\s+-c\b", cmd) is not None
    return True, bounded


STATUS = re.compile(r"\bgh\s+run\s+(list|view)\b(?![^;&|]*--log)|\bheavy\s+(?:[^;&|]*\s)?--status\b")
COMMIT = re.compile(r"\bgit\b[^;&|]*\s(commit|merge|cherry-pick|am)(?![\w-])")


def poll(data, c):
    inp = data.get("tool_input") or {}
    cmd = inp.get("command") or ""
    why = None
    loop, bounded = loop_sleeps(cmd)
    if c["poll_sleep_max"] and loop and not bounded:
        why = "a while/until/for loop that sleeps is a poll; bound it with timeout N (one blocking call) or do not poll"
    elif c["poll_sleep_max"] and not loop and sleeps(cmd) >= c["poll_sleep_max"]:
        why = "sleep %gs (the limit is %ds per call)" % (sleeps(cmd), c["poll_sleep_max"])
    elif c["poll_sleep_max"] and inp.get("run_in_background") and sleeps(cmd) and not loop:
        why = "a sleep in the background is a timer for polling"
    if why is None and c["poll_status_max"] and STATUS.search(cmd):
        with State(data["agent_id"]) as st:
            st["status"] = st.get("status", 0) + 1
            n = st["status"]
        if n > c["poll_status_max"]:
            why = "status check number %d in this agent (gh run list/view, heavy --status; the limit is %d)" % (
                n, c["poll_status_max"])
    if why is None:
        return 0
    sys.stderr.write("fleet poll gate: refused, %s. Polling burnt 22%% of sub-agent tokens (fleet-no-poll-hook-1).\n"
                     "%s\nThresholds: %s (0 = off).\n" % (why, ALTERNATIVE, CONFIG))
    return 2


def exempt(data):
    """Calls that commit or report are never stopped by the cap."""
    if data.get("tool_name") in ("SubagentHandback", "SendMessage"):
        return True
    cmd = (data.get("tool_input") or {}).get("command") or ""
    return data.get("tool_name") == "Bash" and re.search(r"\b(git|nightly)\b", cmd) is not None


def cap(data, c):
    n, N, rep = 0, c["commit_cap"], c["commit_cap_repeat"]
    if not N:
        return 0
    cmd = ((data.get("tool_input") or {}).get("command") or "") if data.get("tool_name") == "Bash" else ""
    with State(data["agent_id"]) as st:
        if COMMIT.search(cmd):
            st["calls"] = 0   # a commit (assumed to succeed; a failed one is retried at once anyway)
            return 0
        st["calls"] = n = st.get("calls", 0) + 1
    if n < N or exempt(data):
        return 0
    hard = n >= 2 * N
    if not hard and n != N and not (rep and (n - N) % rep == 0):
        return 0
    sys.stderr.write(
        "fleet commit cap: %d tool calls in this agent since its last commit (cap %d; fleet-zero-commit-cap-1: 21%% "
        "of tokens went to agents that committed nothing).\n"
        "%s"
        "Now: commit and push what works (one small verified step), or stop and report through SubagentHandback: what "
        "you tried, what blocks you, the exact next step. Say it on the board too (nightly agent say <you> ...; put "
        "commit shas in your leave note). Settings: %s (commit_cap, 0 = off).\n"
        % (n, N, "From %d calls only git, nightly and the hand-back run.\n" % (2 * N) if not hard else
           "Every other tool is refused now; only git, nightly and the hand-back run.\n", CONFIG))
    return 2


def main(argv):
    mode = argv[1] if len(argv) > 1 else ""
    if mode not in ("poll", "cap"):
        sys.stderr.write("usage: fleet_gate.py poll|cap  (a PreToolUse hook; JSON on stdin)\n")
        return 1
    data = json.load(sys.stdin)
    if not data.get("agent_id"):
        return 0                                   # the lead session is not gated
    try:
        c = config()
    except ConfigError as e:
        sys.stderr.write("fleet hook misconfigured, refusing until fixed: %s\n" % e)
        return 2
    if mode == "poll":
        return poll(data, c) if data.get("tool_name") == "Bash" else 0
    r = cap(data, c)
    if r == 0 and time.time() % 50 < 1:
        prune()
    return r


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except SystemExit:
        raise
    except Exception:
        sys.stderr.write("fleet_gate.py crashed (not blocking; fix it):\n" + traceback.format_exc())
        sys.exit(1)
