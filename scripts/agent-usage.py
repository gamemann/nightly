#!/usr/bin/env python3
"""Where the Claude tokens went: per model, per agent type, on this VM and the others.

    scripts/agent-usage.py                     # last 7 days, this VM plus x-tmc-dev02
    scripts/agent-usage.py --days 1 --hosts -  # this VM only
    scripts/agent-usage.py --json              # one JSON object (what --hosts reads back)
    scripts/agent-usage.py --check             # exit 1 if a threshold below is crossed

Reads Claude Code's own transcripts under ~/.claude/projects: a session is
<project>/<id>.jsonl, its sub-agents <project>/<id>/subagents/agent-*.jsonl with the
agent type in the .meta.json beside each. Every assistant message carries its model and
usage; a message streamed in several lines repeats one usage, so they are counted once by
message id. Tokens are input + cache writes + cache reads + output: cache reads dominate,
because a call re-reads its whole context, which is why the agent size and model are the cost.

Why a check exists (CLAUDE.md, "Spawning agents"): opus is for hard cross-addon problems,
sonnet does routine builders and routine orchestration. Nothing enforces that, so this
counts it. The thresholds are where a week has been worth a look, not hard limits:
  - specialist (opus sub-agent) tokens over SPECIALIST_SHARE of all sub-agent tokens;
  - opus sub-agents spawned as builder/scout/researcher, or as an untyped general-purpose
    agent (which inherits the session's model: 111 of those were 70% of a week's tokens on
    dev02 up to 2026-10-14, when the typed agents and the hook that refuses them went in);
  - (reported, not flagged) the opus share of interactive top-level sessions: Christian keeps
    Opus as his sessions' default on purpose (2026-10-18), so it is a number to watch.

Nightly runs are counted apart (type "nightly", sub-agents "nightly:<type>"): from
NIGHTLY_SONNET_SINCE the runner coordinates on Sonnet and its builders run on Opus on
purpose (nightly.md, "Sub-agents"), so an opus nightly builder is the rule there, and a
nightly coordinator on opus is the thing to flag. A run is told apart by the scope note
run.sh appends to its prompt.
"""
import argparse, glob, json, os, subprocess, sys, time
from collections import defaultdict

SPECIALIST_SHARE = 0.20
CHEAP_TYPES = {"builder", "scout", "researcher", "Explore", "general-purpose"}
NIGHTLY_OPUS_OK = {"builder", "specialist"}
NIGHTLY_SONNET_SINCE = time.mktime(time.strptime("2026-10-18T17:47", "%Y-%m-%dT%H:%M"))
NIGHTLY_MARKS = ("## Tonight's scope note", "## Scope note for this run")
_nightly = {}


def is_nightly(session_path):
    """Whether a top-level transcript is a nightly run: its first user message has the scope note."""
    if session_path not in _nightly:
        _nightly[session_path] = False
        try:
            with open(session_path, errors="replace") as f:
                for line in f:
                    if '"user"' in line:
                        _nightly[session_path] = any(m in line for m in NIGHTLY_MARKS)
                        break
        except OSError:
            pass
    return _nightly[session_path]


def family(model):
    for f in ("opus", "sonnet", "haiku", "fable"):
        if f in (model or ""):
            return f
    return model or "?"


def scan(days):
    since = time.time() - days * 86400
    rows = defaultdict(lambda: {"runs": 0, "tokens": 0, "output": 0})
    root = os.path.expanduser("~/.claude/projects")
    for path in glob.glob(root + "/*/*.jsonl") + glob.glob(root + "/*/*/subagents/agent-*.jsonl"):
        try:
            if os.path.getmtime(path) < since:
                continue
        except OSError:
            continue
        sub = "/subagents/" in path
        kind = "main"
        if sub:
            try:
                kind = json.load(open(path[:-6] + ".meta.json")).get("agentType") or "?"
            except (OSError, ValueError):
                kind = "?"
        night = is_nightly(path.split("/subagents/")[0] + ".jsonl" if sub else path)
        seen, models, tok, out, first = set(), defaultdict(int), 0, 0, None
        try:
            f = open(path, errors="replace")
        except OSError:
            continue
        with f:
            for line in f:
                if '"assistant"' not in line:
                    continue
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                if d.get("type") != "assistant":
                    continue
                ts = d.get("timestamp")
                if ts:
                    try:
                        at = time.mktime(time.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S"))
                        if at < since:
                            continue
                        first = at if first is None else min(first, at)
                    except ValueError:
                        pass
                m = d.get("message") or {}
                mid = m.get("id")
                if mid in seen:
                    continue
                seen.add(mid)
                u = m.get("usage") or {}
                t = sum(u.get(k) or 0 for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"))
                models[family(m.get("model"))] += t
                out += u.get("output_tokens") or 0
                tok += t
        if not models:
            continue
        if night:
            # Runs from before the coordinator moved to Sonnet are listed, never flagged.
            tag = "nightly" if (first or 0) >= NIGHTLY_SONNET_SINCE else "nightly-pre"
            kind = tag + ":" + kind if sub else tag
        model = max(models, key=models.get)
        r = rows[(kind, model)]
        r["runs"] += 1
        r["tokens"] += tok
        r["output"] += out
    return [{"type": k, "model": m, **v} for (k, m), v in rows.items()]


def remote(host, days):
    src = open(os.path.abspath(__file__)).read()
    p = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host,
                        "python3", "-", "--json", "--hosts", "-", "--days", str(days)],
                       input=src, capture_output=True, text=True, timeout=600)
    if p.returncode != 0:
        print(f"agent-usage: {host} did not answer: {p.stderr.strip()[:200]}", file=sys.stderr)
        return None
    return json.loads(p.stdout)["hosts"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=float, default=7)
    ap.add_argument("--hosts", default="x-tmc-dev02", help="comma list of other VMs, or - for none")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    hosts = {os.uname().nodename.split(".")[0]: scan(a.days)}
    for h in ([] if a.hosts == "-" else a.hosts.split(",")):
        got = remote(h, a.days)
        if got:
            hosts.update(got)
    if a.json:
        print(json.dumps({"days": a.days, "hosts": hosts}))
        return 0

    all_rows = [dict(r, host=h) for h, rs in hosts.items() for r in rs]
    total = sum(r["tokens"] for r in all_rows) or 1
    print(f"Claude tokens, last {a.days:g} days, on {', '.join(hosts)} ({total / 1e6:.0f}M in all)\n")
    print(f"{'host':14} {'type':28} {'model':7} {'runs':>5} {'Mtok':>7} {'share':>6} {'out k':>7}")
    for r in sorted(all_rows, key=lambda r: -r["tokens"]):
        print(f"{r['host']:14} {r['type']:28} {r['model']:7} {r['runs']:5} {r['tokens'] / 1e6:7.1f} "
              f"{r['tokens'] / total:6.1%} {r['output'] / 1e3:7.0f}")

    flags = []
    for r in all_rows:
        t = r["type"]
        if t == "nightly" and r["model"] == "opus":
            flags.append(f"{r['runs']} nightly run(s) coordinated on opus on {r['host']} ({r['tokens'] / 1e6:.1f}M): "
                         "run.sh passes --model $NIGHTLY_MODEL (default sonnet); check it is still there")
        elif t.startswith("nightly:") and r["model"] == "opus" and t[8:] not in NIGHTLY_OPUS_OK:
            flags.append(f"{r['runs']} nightly {t[8:]} run(s) on opus on {r['host']} ({r['tokens'] / 1e6:.1f}M): "
                         "only builders and specialists do nightly work on opus")
    all_rows = [r for r in all_rows if not r["type"].startswith("nightly")]
    sub = [r for r in all_rows if r["type"] != "main"]
    sub_tok = sum(r["tokens"] for r in sub) or 1
    spec = sum(r["tokens"] for r in sub if r["type"] == "specialist")
    if spec / sub_tok > SPECIALIST_SHARE:
        flags.append(f"specialist is {spec / sub_tok:.0%} of sub-agent tokens (over {SPECIALIST_SHARE:.0%}): "
                     "check each was a hard cross-addon problem or a failed builder")
    for r in sub:
        if r["type"] in CHEAP_TYPES and r["model"] == "opus":
            flags.append(f"{r['runs']} {r['type']} run(s) on opus on {r['host']} ({r['tokens'] / 1e6:.1f}M): "
                         "a model override on a cheap agent type, or an untyped spawn")
    main_rows = [r for r in all_rows if r["type"] == "main"]
    main_tok = sum(r["tokens"] for r in main_rows) or 1
    opus_main = sum(r["tokens"] for r in main_rows if r["model"] == "opus")
    print()
    print(f"Interactive top-level sessions: {opus_main / main_tok:.0%} of their tokens on opus (the default by choice).")
    print("\n".join("FLAG " + f for f in flags) if flags else "No flags: model use matches the rules.")
    return 1 if (a.check and flags) else 0


if __name__ == "__main__":
    sys.exit(main())
