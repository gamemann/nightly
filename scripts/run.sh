#!/usr/bin/env bash
# The runner: one Claude Code run across a workspace (a directory of Git repositories).
# Started by `nightly exec` -- through `nightly tick` from the crontab, or Run now in the
# panel -- which creates the Run row, streams this script's output into it, and closes the
# run if the agent did not. What to do lives in the nightly database (items and prompts);
# this script only decides whether to run, which repositories are safe to touch, and
# launches Claude.
#
# Use it as is, or as the starting point for your own:
#   bin/nightly prompt set run.sh --file scripts/run.sh     # store it as the runner (Prompts)
#   bin/nightly set-setting runner scripts/run.sh           # or run this file in place
#
# From `nightly exec`: NIGHTLY_RUN_ID, NIGHTLY_ROOT, NIGHTLY_SCHEDULE_NAME, NIGHTLY_PROMPT,
# NIGHTLY_INSTRUCTIONS, NIGHTLY_MAX_TURNS, NIGHTLY_TRIGGER.
#
# Configuration (environment, or the repository's .env, which the CLI loads):
#   NIGHTLY_WORKSPACE        the directory of repositories to work in (default: the parent of NIGHTLY_ROOT)
#   NIGHTLY_REQUIRED_TOOLS   commands to warn about when missing (default: "git node npm")
#   NIGHTLY_IDLE_MINUTES     a dirty repo counts as mid-edit if a dirty file changed this recently (default: 90)
#   NIGHTLY_REPO_DEPTH       how deep under the workspace to look for repositories (default: 3)
#   NIGHTLY_USAGE_SCRIPT     plan-usage check (default: scripts/claude-usage.sh); "off" disables it
#   NIGHTLY_SCOPE_HOOK       optional executable; whatever it prints is added to the scope note
#   NIGHTLY_CLAUDE_BIN       the claude binary (default: claude)
#   NIGHTLY_CLAUDE_ARGS      extra arguments for claude -p (e.g. "--model claude-opus-5-5")
#   NIGHTLY_SKIP_PERMISSIONS "0" to run without --dangerously-skip-permissions (default: 1; an
#                            unattended run cannot answer permission prompts)
set -euo pipefail

# Cron's PATH is bare and ~/.bashrc usually returns early when non-interactive.
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$HOME/go/bin:/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

RUN_ID="${NIGHTLY_RUN_ID:?start runs with: bin/nightly start <schedule>}"
ROOT="${NIGHTLY_ROOT:?NIGHTLY_ROOT is set by nightly exec}"
NIGHTLY="$ROOT/bin/nightly"
WORKSPACE_DIR="${NIGHTLY_WORKSPACE:-$(dirname "$ROOT")}"
PROMPT_NAME="${NIGHTLY_PROMPT:-nightly.md}"
MAX_TURNS="${NIGHTLY_MAX_TURNS:-400}"            # runaway guard only
IDLE_MINUTES="${NIGHTLY_IDLE_MINUTES:-90}"
REPO_DEPTH="${NIGHTLY_REPO_DEPTH:-3}"
USAGE_SCRIPT="${NIGHTLY_USAGE_SCRIPT:-$ROOT/scripts/claude-usage.sh}"
CLAUDE_BIN="${NIGHTLY_CLAUDE_BIN:-claude}"
read -r -a REQUIRED_TOOLS <<< "${NIGHTLY_REQUIRED_TOOLS:-git node npm}"
read -r -a EXTRA_ARGS <<< "${NIGHTLY_CLAUDE_ARGS:-}"
[ "${NIGHTLY_SKIP_PERMISSIONS:-1}" = "0" ] || EXTRA_ARGS+=(--dangerously-skip-permissions)
# `claude -p` stops waiting for background tasks after 600 s by default and kills them, which
# cuts a run off mid-item with its work uncommitted. An hour: long enough for a long test
# suite, still finite so a hung task cannot hold the machine all day.
export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS="${CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS:-3600000}"

missing=()
for t in "${REQUIRED_TOOLS[@]}"; do command -v "$t" >/dev/null 2>&1 || missing+=("$t"); done
[ "${#missing[@]}" -eq 0 ] || echo "Warning: not on PATH, work needing them will be skipped: ${missing[*]}"
command -v "$CLAUDE_BIN" >/dev/null 2>&1 || { echo "Error: $CLAUDE_BIN is not on PATH."; exit 1; }
[ -d "$WORKSPACE_DIR" ] || { echo "Error: workspace $WORKSPACE_DIR does not exist (NIGHTLY_WORKSPACE)."; exit 1; }

PROMPT_TEXT=$("$NIGHTLY" prompt show "$PROMPT_NAME") || { echo "Error: no prompt named $PROMPT_NAME (add it under Prompts)."; exit 1; }

# Plan usage: skip when either window is already at its limit (Settings -> Usage limits),
# rather than spending the next window's budget or stopping half way through an item.
# The check's exit 2 means the check itself is broken (it reads an undocumented event):
# the run goes ahead and is told so -- a broken gauge must never stop every run.
usage_rc=2; usage_line="usage check off"
if [ "$USAGE_SCRIPT" != "off" ]; then
  usage_five=$("$NIGHTLY" get usageMaxFiveHour 2>/dev/null || true); usage_five="${usage_five:-80}"
  usage_week=$("$NIGHTLY" get usageMaxWeekly 2>/dev/null || true); usage_week="${usage_week:-90}"
  usage_rc=0
  if [ -x "$USAGE_SCRIPT" ]; then
    usage_line=$("$USAGE_SCRIPT" --check "$usage_five" "$usage_week" 2>&1) || usage_rc=$?
  else
    usage_line="UNKNOWN: $USAGE_SCRIPT is missing"; usage_rc=2
  fi
  echo "Usage: $usage_line"
  if [ "$usage_rc" -eq 1 ]; then
    "$NIGHTLY" run finish "$RUN_ID" --status skipped --summary "Skipped: plan usage at its limit. $usage_line" >/dev/null
    exit 0
  fi
fi

cd "$WORKSPACE_DIR"

# A dirty repo is in scope (its work gets committed first) unless a file git reports dirty
# changed in the last IDLE_MINUTES -- then somebody is mid-edit and it is left alone. Only
# dirty paths are measured: dev servers rewrite gitignored files constantly, and those never
# appear in `status --porcelain`.
repo_is_quiet() {
  local repo="$1" path
  while IFS= read -r path; do
    path="${path:3}"; path="${path%\"}"; path="${path#\"}"
    [ -e "$repo/$path" ] || continue
    [ -z "$(find "$repo/$path" -mmin "-$IDLE_MINUTES" -print -quit 2>/dev/null)" ] || return 1
  done < <(git -C "$repo" status --porcelain 2>/dev/null)
}

commit_first=(); skipped=()
while IFS= read -r repo; do
  git -C "$repo" rev-parse --verify -q HEAD >/dev/null 2>&1 || continue   # no commits: nothing to protect
  [ -n "$(git -C "$repo" status --porcelain)" ] || continue
  if repo_is_quiet "$repo"; then commit_first+=("$repo"); else skipped+=("$repo"); fi
done < <(
  # Hidden directories are pruned, so worktrees under .claude/ are not counted.
  find . -mindepth 1 -maxdepth "$REPO_DEPTH" \( -type d -name '.*' \) -prune -o \
         -type d -exec test -e '{}/.git' \; -print -prune | sed 's|^\./||' | sort
)

scope=$'\n\n---\n\n## Scope note for this run\n\nEverything under '"$WORKSPACE_DIR"$' is in scope except as listed here.'
scope+=$'\n\n**Your run id is '"$RUN_ID"$'** (`'"$NIGHTLY"$' run start` prints it). Join the agent board as `nightly-'"$RUN_ID"$'` and claim each repository before changing it (`'"$NIGHTLY"$' agent --help`).'
if [ "$usage_rc" -eq 0 ]; then
  scope+=$'\n\n**Plan usage at the start:** '"$usage_line"$'. Between items, run `'"$USAGE_SCRIPT"' --check '"$usage_five $usage_week"$'`; when it exits 1, finish the item in hand, write the report and stop.'
elif [ "$USAGE_SCRIPT" != "off" ]; then
  scope+=$'\n\n**The plan-usage check is broken** ('"$usage_line"$'). Carry on as usual and say so in the report.'
fi
if [ "${#commit_first[@]}" -gt 0 ]; then
  scope+=$'\n\n**Commit what is already there first** (uncommitted, but quiet for '"$IDLE_MINUTES"$' min): '"${commit_first[*]}"
fi
if [ "${#skipped[@]}" -gt 0 ]; then
  scope+=$'\n\n**Out of scope** (uncommitted AND edited in the last '"$IDLE_MINUTES"$' min -- somebody is mid-edit; do not read, build or commit there, and list them in the report): '"${skipped[*]}"
  echo "Skipping busy repos: ${skipped[*]}"
fi
if [ -n "${NIGHTLY_SCOPE_HOOK:-}" ]; then
  if hook_out=$("$NIGHTLY_SCOPE_HOOK" 2>&1); then
    [ -z "$hook_out" ] || scope+=$'\n\n'"$hook_out"
  else
    echo "Warning: NIGHTLY_SCOPE_HOOK failed: $hook_out"
  fi
fi
# The schedule's own instructions (Schedules in the panel) come last and narrow everything above.
if [ -n "${NIGHTLY_INSTRUCTIONS:-}" ]; then
  scope+=$'\n\n## This schedule: '"${NIGHTLY_SCHEDULE_NAME:-unnamed}"$'\n\n'"$NIGHTLY_INSTRUCTIONS"
fi

RESULT_FILE=$(mktemp -t "nightly-run-$RUN_ID.XXXXXX.json")
trap 'rm -f "$RESULT_FILE"' EXIT
echo "Starting $CLAUDE_BIN (prompt $PROMPT_NAME, max $MAX_TURNS turns)"
status=0
"$CLAUDE_BIN" -p "$PROMPT_TEXT$scope" \
  --output-format json \
  --max-turns "$MAX_TURNS" \
  "${EXTRA_ARGS[@]}" \
  > "$RESULT_FILE" < /dev/null || status=$?   # stderr stays on ours, so it reaches the run's log

# Claude's final message goes into the run's log; turns, minutes and cost into its columns.
RESULT_FILE="$RESULT_FILE" python3 - <<'PY'
import json, os
raw = open(os.environ["RESULT_FILE"], errors="replace").read()
try:
    data = json.loads(raw)
except ValueError:
    data = None
if data is None:
    print("--- no JSON result: the run was killed before it could report ---")
    print(raw[-4000:])
else:
    print(data.get("result") or "(no final message)")
    minutes = int(data.get("duration_ms") or 0) // 60000
    print(f"--- turns {data.get('num_turns','?')} | minutes {minutes} | stop {data.get('subtype') or data.get('stop_reason') or '?'} ---")
    print("::nightly-meta " + json.dumps({"turns": data.get("num_turns"), "minutes": minutes, "costUsd": data.get("total_cost_usd")}))
PY
echo "--- claude exit=$status; skipped: ${skipped[*]:-none} ---"
exit "$status"
