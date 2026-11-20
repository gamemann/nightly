#!/usr/bin/env python3
"""Fleet guards, run by Claude Code as PreToolUse hooks. Sub-agents only (the hook input has agent_id); the lead
session is never gated. Run with `python3 -S` (no site import: a third of the per-call cost).

    fleet_gate.py poll   (matcher Bash)  fleet-no-poll-hook-1: polling cost 22% of sub-agent tokens 2026-11-12..19.
        Refuses: a sleep of poll_sleep_max seconds or more in one call (sum of the call's sleeps, a `for` loop over a
        literal list or seq counted per pass); a while/until loop, or a for loop of unknown length, that sleeps and is
        not bounded by `timeout N`; a background call that starts with sleep (a timer); a status poll (gh run
        list/view without --log, heavy --status) after poll_status_max of them in poll_status_window seconds or since
        the agent's last commit. Quoted text and here-documents given to non-shell commands (grep, echo, git -m,
        nightly note, cat <<EOF > file) are data, not code, and never count.
    fleet_gate.py cap    (matcher *)     fleet-zero-commit-cap-1: 21% of tokens went to agents that committed nothing.
        Counts tool calls since the agent's last `git commit` (also merge, cherry-pick, am, revert) that really moved
        HEAD: the reset waits until the repo's HEAD reflog shows an entry newer than the call (a failed commit resets
        nothing; a repo that cannot be read is trusted). At commit_cap the call is refused once with a report demand,
        then once every commit_cap_repeat calls; from 2 x commit_cap every call is refused except a Bash call that
        runs git or nightly as a command, and the hand-back, so the agent commits or reports.

Configuration: ~/.claude/fleet-hooks.json {"poll_sleep_max": 20, "poll_status_max": 3, "poll_status_window": 3600,
"commit_cap": 150, "commit_cap_repeat": 25}, overridden by the environment FLEET_POLL_SLEEP_MAX, FLEET_POLL_STATUS_MAX,
FLEET_POLL_STATUS_WINDOW, FLEET_COMMIT_CAP, FLEET_COMMIT_CAP_REPEAT. 0 turns a guard off (a window of 0 = until the
next commit). A bad value is refused loudly (exit 2, names the setting); a crash of the hook itself exits 1 with the
traceback (shown, not blocking). State: ~/.claude/fleet-hooks-state/<agent_id>.json.
Versioned in nightly scripts/fleet-hooks (tests: test_fleet_gate.py); installed as a symlink in ~/.claude/hooks.
"""
import fcntl
import json
import os
import re
import subprocess
import sys
import time
import traceback

DEFAULTS = {"poll_sleep_max": 20, "poll_status_max": 3, "poll_status_window": 3600, "commit_cap": 150,
            "commit_cap_repeat": 25}
HOME = os.path.expanduser("~")
CONFIG = os.environ.get("FLEET_HOOKS_CONFIG", os.path.join(HOME, ".claude", "fleet-hooks.json"))
STATE = os.environ.get("FLEET_HOOKS_STATE", os.path.join(HOME, ".claude", "fleet-hooks-state"))
PENDING_MAX_S = 900          # how long a commit call may take to show up in the reflog before it counts as failed

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


# ---- reading a Bash command: simple commands, their command word, and which text is data

PREFIX_OPTS = {"sudo": {"-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U"}, "timeout": {"-s", "-k", "--signal",
               "--kill-after"}, "env": {"-u", "-C", "-S"}, "nice": {"-n"}, "ionice": {"-c", "-n"}}
PREFIX = {"sudo", "timeout", "env", "nohup", "time", "exec", "command", "nice", "ionice", "builtin", "then", "do",
          "else", "elif", "if", "while", "until", "!", "{", "xargs", "stdbuf", "setsid"}
SHELLS = {"bash", "sh", "zsh", "dash", "ssh", "eval", "watch", "su"}


def scan(cmd):
    """Split cmd into simple commands outside quotes. Returns [(start, end)] spans and the quoted [(start, end)] spans
    (inner text), and here-document bodies as [(start, end, segment index)]."""
    segs, quotes, heres = [], [], []
    i, n, start, pending_here = 0, len(cmd), 0, []
    while i < n:
        ch = cmd[i]
        if ch == "\\" and i + 1 < n:
            i += 2
            continue
        if ch in "'\"":
            j = i + 1
            while j < n and cmd[j] != ch:
                j += 2 if (ch == '"' and cmd[j] == "\\") else 1
            quotes.append((i + 1, min(j, n)))
            i = j + 1
            continue
        if ch == "<" and cmd.startswith("<<", i) and not cmd.startswith("<<<", i):
            m = re.match(r"<<-?\s*(['\"]?)([\w.-]+)\1", cmd[i:])
            if m:
                pending_here.append(m.group(2))
                i += m.end()
                continue
        if ch == "\n" and pending_here:
            segs.append((start, i))
            j = i + 1
            for tag in pending_here:
                m = re.compile(r"^[ \t]*" + re.escape(tag) + r"[ \t]*$", re.M).search(cmd, j)
                end = m.start() if m else n
                heres.append((j, end, len(segs) - 1))
                j = m.end() if m else n
            pending_here = []
            i = start = j
            continue
        if ch in ";&|()\n`" or (ch == "$" and cmd.startswith("$(", i)):
            segs.append((start, i))
            i += 2 if ch == "$" else 1
            start = i
            continue
        i += 1
    segs.append((start, n))
    return [s for s in segs], quotes, heres


def words(text):
    return re.findall(r"(?:[^\s'\"]|'[^']*'|\"[^\"]*\")+", text)


def command_word(text):
    """The program a simple command runs (basename), past sudo/timeout/env/VAR=x prefixes; and its arguments."""
    w = words(text)
    i = 0
    while i < len(w):
        t = w[i]
        b = os.path.basename(t.strip("'\""))
        if re.match(r"^[A-Za-z_]\w*=", t):
            i += 1
        elif b in PREFIX:
            i += 1
            opts = PREFIX_OPTS.get(b, set())
            while i < len(w) and w[i].startswith("-"):
                i += 2 if w[i] in opts else 1
            if b == "timeout" and i < len(w) and re.match(r"^[0-9.]+[smhd]?$", w[i]):
                i += 1
        else:
            return b, w[i + 1:]
    return "", []


def code_of(cmd):
    """cmd with data blanked: quoted text and here-documents of commands that are not shells. Also the simple
    commands as (command word, args, text)."""
    segs, quotes, heres = scan(cmd)
    out = list(cmd)
    parsed = []
    for k, (a, b) in enumerate(segs):
        word, args = command_word(cmd[a:b])
        parsed.append((word, args, cmd[a:b]))
        if word and word not in SHELLS:
            for qa, qb in quotes:
                if a <= qa and qb <= b:
                    out[qa:qb] = " " * (qb - qa)
    for ha, hb, k in heres:
        if parsed[k][0] not in SHELLS:
            out[ha:hb] = [c if c == "\n" else " " for c in cmd[ha:hb]]
    return "".join(out), parsed


SECONDS = {"": 1, "s": 1, "m": 60, "h": 3600, "d": 86400}
SLEEP = re.compile(r"(?:^|[;&|(`{\s'\"]|\$\()sleep((?:\s+[0-9.]+[smhd]?)+)")


def sleeps(code):
    """Seconds slept by the sleep commands of code (each argument of sleep is added, like sleep itself does)."""
    total = 0.0
    for m in SLEEP.finditer(code):
        for a in m.group(1).split():
            n = re.match(r"([0-9.]+)([smhd]?)$", a)
            if n:
                try:
                    total += float(n.group(1)) * SECONDS[n.group(2)]
                except ValueError:
                    pass
    return total


LOOP = re.compile(r"(?:^|[;&|({\s'\"])(while|until|for)\s(.*?)\bdo\b((?:(?!\bdone\b).)*)", re.S)


def passes(head):
    """How many times a `for` loop runs, when its list is literal, `$(seq ..)` or `{a..b}`; else None."""
    m = re.match(r"\s*\w+\s+in\s+(.*?)\s*;?\s*$", head, re.S)
    if not m:
        return None
    lst = m.group(1).strip()
    s = re.match(r"^\$\(\s*seq\s+(?:(-?\d+)\s+)?(?:(-?\d+)\s+)?(-?\d+)\s*\)$", lst)
    if s:
        a, step, b = int(s.group(1) or 1), 1, int(s.group(3))
        if s.group(2):
            step = int(s.group(2))
        return max(0, (b - a) // step + 1) if step > 0 else None
    r = re.match(r"^\{(-?\d+)\.\.(-?\d+)\}$", lst)
    if r:
        return abs(int(r.group(2)) - int(r.group(1))) + 1
    toks = lst.split()
    if toks and not any(re.search(r"[$*?`\[{]", t) for t in toks):
        return len(toks)
    return None


def poll_sleep(code):
    """(seconds slept by the call, counting a for loop of known length per pass; whether an unbounded loop sleeps)."""
    total, unbounded, rest = 0.0, False, code
    for m in LOOP.finditer(code):
        body = sleeps(m.group(3))
        if not body:
            continue
        k = passes(m.group(2)) if m.group(1) == "for" else None
        if k is None:
            unbounded = True
        else:
            total += k * body
        rest = rest.replace(m.group(3), " ", 1)
    return total + sleeps(rest), unbounded


def prefixes(text):
    """The prefix words (sudo, timeout N, nohup, ...) in front of a simple command's program."""
    w, i, out = words(text), 0, []
    while i < len(w):
        b = os.path.basename(w[i].strip("'\""))
        if re.match(r"^[A-Za-z_]\w*=", w[i]):
            i += 1
        elif b in PREFIX:
            i += 1
            opts = PREFIX_OPTS.get(b, set())
            while i < len(w) and w[i].startswith("-"):
                i += 2 if w[i] in opts else 1
            if b == "timeout":
                if i < len(w) and re.match(r"^[0-9.]+[smhd]?$", w[i]):
                    out.append(b)
                    i += 1
            else:
                out.append(b)
        else:
            break
    return out


def unbound(text):
    """text with the bodies of loops blanked where they cannot poll for long: inside a command run under timeout N
    (one blocking call, however it nests: timeout 590 ssh box 'until ..', ssh box 'timeout 200 bash -c ..', a for
    retry around a timeout), or in a job detached with nohup/setsid .. &. Plain sleeps stay, so a timer is a timer."""
    segs, quotes, _ = scan(text)
    out = list(text)
    for a, b in segs:
        seg = text[a:b]
        pre = prefixes(seg)
        detached = b < len(text) and text[b] == "&" and not text.startswith("&&", b) and (
            "nohup" in pre or "setsid" in pre)
        if "timeout" in pre or detached:
            for m in LOOP.finditer(seg):
                out[a + m.start(3):a + m.end(3)] = " " * (m.end(3) - m.start(3))
        elif command_word(seg)[0] in SHELLS:
            for qa, qb in quotes:
                if a <= qa and qb <= b:
                    out[qa:qb] = list(unbound(text[qa:qb]))
    return "".join(out)


STATUS = re.compile(r"\bgh\s+run\s+(list|view)\b(?![^;&|]*--log)|\bheavy\s+(?:[^;&|]*\s)?--status\b")


def status_checks(st, c, now):
    """Status checks counted against the limit: those in the window and after the last commit."""
    since = st.get("commit_at", 0)
    if c["poll_status_window"]:
        since = max(since, now - c["poll_status_window"])
    return [t for t in st.get("status_at", []) if t >= since]


def poll(data, c):
    inp = data.get("tool_input") or {}
    cmd = inp.get("command") or ""
    code, parsed = code_of(unbound(cmd))
    why = None
    total, unbounded = poll_sleep(code)
    if c["poll_sleep_max"] and unbounded:
        why = "a while/until loop, or a for loop over an unknown list, that sleeps is a poll; bound it with timeout N " \
              "(one blocking call) or do not poll"
    elif c["poll_sleep_max"] and total >= c["poll_sleep_max"]:
        why = "sleep %gs (the limit is %ds per call)" % (total, c["poll_sleep_max"])
    elif c["poll_sleep_max"] and inp.get("run_in_background") and next((w for w, _, _ in parsed if w), "") == "sleep":
        why = "a background call that starts with sleep is a timer for polling"
    if why is None and c["poll_status_max"] and STATUS.search(code):
        now = time.time()
        with State(data["agent_id"]) as st:
            seen = status_checks(st, c, now) + [now]
            st["status_at"] = seen
            n = len(seen)
        if n > c["poll_status_max"]:
            why = "status check number %d in this agent (gh run list/view, heavy --status; the limit is %d per %s " \
                  "and per commit)" % (n, c["poll_status_max"], "%ds" % c["poll_status_window"]
                                       if c["poll_status_window"] else "commit")
    if why is None:
        return 0
    sys.stderr.write("fleet poll gate: refused, %s. Polling burnt 22%% of sub-agent tokens (fleet-no-poll-hook-1).\n"
                     "%s\nThresholds: %s (0 = off).\n" % (why, ALTERNATIVE, CONFIG))
    return 2


# ---- the commit cap

COMMITS = {"commit", "merge", "cherry-pick", "am", "revert"}
NO_COMMIT = {"--dry-run", "-h", "--help", "--abort", "--quit", "--skip", "--show-current-patch"}
GIT_OPT_ARG = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"}


def git_commit(parsed, cwd):
    """The directory of a git commit/merge/cherry-pick/am/revert in the call ('' when it cannot be told), or None."""
    base = cwd or ""
    for word, args, _ in parsed:
        if word == "cd" and args:
            base = expand(args[0], base)
            continue
        if word != "git":
            continue
        d, i = base, 0
        while i < len(args) and args[i].startswith("-"):
            if args[i] == "-C" and i + 1 < len(args):
                d = expand(args[i + 1], d)
            i += 2 if args[i] in GIT_OPT_ARG else 1
        if i < len(args) and args[i] in COMMITS and not NO_COMMIT.intersection(args[i + 1:]):
            return d
    return None


def expand(p, base):
    p = p.strip("'\"")
    if p.startswith("~"):
        p = os.path.expanduser(p)
    p = p.replace("${HOME}", HOME).replace("$HOME", HOME)
    if "$" in p or "`" in p or not base and not p.startswith("/"):
        return ""
    return os.path.normpath(os.path.join(base, p))


def landed(d, since):
    """True when the HEAD reflog of repo d has an entry from `since` on; also True when d cannot be read (trust the
    agent rather than block real work); False only when the repo reads fine and nothing moved."""
    if not d or not os.path.isdir(d):
        return True
    try:
        r = subprocess.run(["git", "-c", "safe.directory=*", "-C", d, "log", "-g", "-1", "--date=unix", "--format=%gd",
                            "HEAD"], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return True
    m = re.search(r"\{(\d+)\}", r.stdout)
    if r.returncode != 0 or not m:
        return True
    return int(m.group(1)) >= int(since)


def exempt(data, parsed):
    """Calls that commit or report are never stopped by the cap: the hand-back, a message, and Bash that runs git or
    nightly as a command (`cat .gitignore` or a path under nightly/ is not one)."""
    if data.get("tool_name") in ("SubagentHandback", "SendMessage"):
        return True
    return data.get("tool_name") == "Bash" and any(w in ("git", "nightly") for w, _, _ in parsed)


def cap(data, c):
    N, rep = c["commit_cap"], c["commit_cap_repeat"]
    if not N:
        return 0
    cmd = ((data.get("tool_input") or {}).get("command") or "") if data.get("tool_name") == "Bash" else ""
    parsed = code_of(cmd)[1] if cmd else []
    now = time.time()
    with State(data["agent_id"]) as st:
        n = st.get("calls", 0) + 1
        p = st.get("pending")
        if p:
            if landed(p["dir"], p["at"]):
                n -= p["mark"]            # the calls made since the commit call
                st["commit_at"] = p["at"]
                st["pending"] = None
            elif now - p["at"] > PENDING_MAX_S:
                st["pending"] = None      # the commit failed; the count goes on
        st["calls"] = n
        d = git_commit(parsed, data.get("cwd")) if cmd else None
        if d is not None:
            st["pending"] = {"dir": d, "at": now, "mark": n}
            return 0
    if n < N or exempt(data, parsed):
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
