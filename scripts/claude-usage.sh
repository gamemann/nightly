#!/usr/bin/env bash
# The Claude plan usage of the account `claude` is signed in as: the 5-hour and 7-day
# windows, as a percentage and a reset time. Needs `claude` and python3 on PATH.
#
#   scripts/claude-usage.sh                  # human-readable
#   scripts/claude-usage.sh --json           # one JSON object
#   scripts/claude-usage.sh --check 80 90    # exit 1 if the 5-hour window is at/over 80%
#                                            # or the 7-day window at/over 90%
#   scripts/claude-usage.sh --input FILE ... # parse saved stream-json instead of asking
#
# Exit codes: 0 ok (or under the limits), 1 over a limit, 2 UNKNOWN -- nothing usable came
# back. A caller must treat 2 as "the check is broken", not as "fine" or "over".
#
# WHERE THE NUMBERS COME FROM, and why there are fallbacks. Nothing documented exposes plan
# usage outside the interactive /usage screen. `claude -p --output-format stream-json
# --verbose` does emit a `rate_limit_event` before its answer (seen in Claude Code 2.1.285,
# 2026-10-04), which is undocumented and can change in any release. So the parse tries, in
# order, and says in "source" which one answered:
#   1. "unified"  rate_limit_info.unifiedWindows.{five_hour,seven_day}.{utilization,resetsAt}
#   2. "search"   any dict anywhere in a rate-limit-ish event that carries a utilization-like
#                 number, named by the nearest key that looks like a window (five/5h/hour,
#                 seven/7d/week) -- survives renames and re-nesting
#   3. "status"   rate_limit_info.status alone: "rejected" means over, with rateLimitType and
#                 resetsAt; no percentages
#   4. "result"   the probe's own result is an error that mentions a usage/rate limit: over
#   5. none       exit 2, and the raw output is kept in $CLAUDE_USAGE_DEBUG_FILE (default
#                 data/usage-probe-last.jsonl in this repository) for whoever fixes the parse.
# Each call without --input costs one one-word request against the 5-hour window.
set -uo pipefail

mode="text"; five_limit=""; week_limit=""; input=""
while [ $# -gt 0 ]; do
    case "$1" in
        --json) mode="json" ;;
        --check)
            mode="check"; five_limit="${2:-}"; week_limit="${2:-}"; shift
            if [[ "${2:-}" =~ ^[0-9.]+$ ]]; then week_limit="$2"; shift; fi ;;
        --input) input="${2:-}"; shift ;;
        -h|--help) sed -n '2,/^set -uo/p' "$0" | sed '$d'; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
    shift
done
if [ "$mode" = "check" ] && ! [[ "$five_limit" =~ ^[0-9.]+$ ]]; then
    echo "--check needs a percentage: --check 80 [90]" >&2; exit 2
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
debug_file="${CLAUDE_USAGE_DEBUG_FILE:-$root/data/usage-probe-last.jsonl}"

if [ -n "$input" ]; then
    raw="$(cat "$input")" || exit 2
else
    command -v claude >/dev/null 2>&1 || { echo "UNKNOWN: claude is not on PATH" >&2; exit 2; }
    raw="$(cd /tmp && timeout 120 claude -p --output-format stream-json --verbose --max-turns 1 \
        "Reply with the single word ok." 2>&1)"
fi

MODE="$mode" FIVE="$five_limit" WEEK="$week_limit" DEBUG_FILE="$debug_file" python3 -c '
import datetime, json, os, re, sys

raw = sys.stdin.read()
events = []
for line in raw.splitlines():
    try:
        e = json.loads(line)
    except ValueError:
        continue
    if isinstance(e, dict):
        events.append(e)

def when(ts):
    try:
        ts = float(ts)
        if ts > 1e12:                       # milliseconds
            ts /= 1000.0
        return datetime.datetime.fromtimestamp(ts).astimezone().isoformat(timespec="minutes")
    except (TypeError, ValueError):
        return str(ts) if ts else None

def pct(v):
    v = float(v)
    return round(v * 100.0 if v <= 1.0 else v, 1)    # 0.29 and 29 both mean 29%

def window_name(key):
    k = str(key).lower()
    if re.search(r"five|5h|5_h|hour", k): return "five_hour"
    if re.search(r"seven|7d|7_d|week", k): return "seven_day"
    return None

USAGE_KEYS = ("utilization", "used_percentage", "usedPercentage", "percent_used", "percentUsed", "percentage", "percent")
RESET_KEYS = ("resetsAt", "resets_at", "resetAt", "reset_at", "resets")

rl_events = [e for e in events if e.get("type") != "assistant" and "rate" in json.dumps(e).lower() and "limit" in json.dumps(e).lower()]
result = {"five_hour": None, "seven_day": None, "status": None, "source": None}

# 1. The format seen on 2026-10-04.
for e in rl_events:
    info = e.get("rate_limit_info") or {}
    w = info.get("unifiedWindows") or {}
    for name in ("five_hour", "seven_day"):
        v = w.get(name)
        if isinstance(v, dict) and isinstance(v.get("utilization"), (int, float)):
            result[name] = {"percent": pct(v["utilization"]), "resets_at": when(v.get("resetsAt"))}
    if result["five_hour"] or result["seven_day"]:
        result["source"] = "unified"
        result["status"] = info.get("status")
        break

# 2. Anything shaped like a usage number, anywhere in a rate-limit event.
if not result["source"]:
    def walk(node, label):
        if isinstance(node, dict):
            name = window_name(label) if label else None
            num = next((node[k] for k in USAGE_KEYS if isinstance(node.get(k), (int, float))), None)
            if name and num is not None and result[name] is None:
                reset = next((node[k] for k in RESET_KEYS if node.get(k)), None)
                result[name] = {"percent": pct(num), "resets_at": when(reset)}
            for k, v in node.items():
                walk(v, k if window_name(k) else label)
        elif isinstance(node, list):
            for v in node:
                walk(v, label)
    for e in rl_events:
        walk(e, None)
        if not result["status"]:
            result["status"] = (e.get("rate_limit_info") or {}).get("status")
    if result["five_hour"] or result["seven_day"]:
        result["source"] = "search"

# 3. The status alone.
if not result["source"]:
    for e in rl_events:
        info = e.get("rate_limit_info") or {}
        if info.get("status"):
            result["status"] = info["status"]
            result["source"] = "status"
            result["limited_window"] = info.get("rateLimitType")
            result["resets_at"] = when(info.get("resetsAt"))
            break

# 4. The probe itself was refused for a limit.
if not result["source"]:
    pattern = r"(usage|rate)[ _-]?limit|limit reached|hit your (usage )?limit|out of (extra )?usage"
    for e in events:
        if e.get("type") == "result" and e.get("is_error") and re.search(pattern, json.dumps(e).lower()):
            result["status"], result["source"] = "rejected", "result"
    if not result["source"] and not events and re.search(pattern, raw.lower()):
        result["status"], result["source"] = "rejected", "result"

mode = os.environ["MODE"]

if not result["source"]:
    path = os.environ["DEBUG_FILE"]
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w") as f:
            f.write(raw)
        kept = "raw output kept in " + path
    except OSError:
        kept = "raw output could not be saved"
    types = sorted({str(e.get("type")) for e in events})
    print("UNKNOWN: no usage figures in the probe (event types: %s; %s)" % (", ".join(types) or "none", kept), file=sys.stderr)
    if mode == "json":
        print(json.dumps(result))
    sys.exit(2)

over_status = str(result.get("status") or "").lower() == "rejected"

if mode == "json":
    print(json.dumps(result))
    sys.exit(0)

if mode == "check":
    over = []
    for name, lim in (("five_hour", os.environ["FIVE"]), ("seven_day", os.environ["WEEK"])):
        w = result.get(name)
        if w and lim and w["percent"] >= float(lim):
            over.append("%s %.1f%% >= %s%%" % (name, w["percent"], lim))
    if over_status:
        over.append("status rejected (%s)" % (result.get("limited_window") or "a limit"))
    shown = ", ".join("%s %.1f%%" % (n, result[n]["percent"]) for n in ("five_hour", "seven_day") if result.get(n)) or "no percentages"
    print("%s [source %s] %s" % ("OVER: " + "; ".join(over) + " --" if over else "under the limits --", result["source"], shown))
    sys.exit(1 if over else 0)

for name in ("five_hour", "seven_day"):
    w = result.get(name)
    if w:
        print("%-10s %5.1f%%   resets %s" % (name, w["percent"], w["resets_at"]))
print("status     %s   (source: %s)" % (result.get("status"), result["source"]))
sys.exit(1 if over_status else 0)
' <<< "$raw"
