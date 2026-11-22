#!/usr/bin/env bash
# chk-ci-red.sh: is the latest completed CI run on every default branch green? (nightly check, report only)
# Wraps dot-bootstrap tools/ci-red.sh, the shared tool: for each repo in projects.tsv it reads the default branch's newest
# completed run (not the Images workflow) from the internal Forgejo first (zero GitHub API calls, docs/forgejo-ci.md in
# dot-bootstrap), and asks GitHub only for repos Forgejo has no run for, cached 15 min (CI_RED_GITHUB=0: never). That tool asks gh here, or ssh's to the box
# where gh is logged in when gh is logged out here, so this script does not duplicate that logic.
# Every red default branch prints a FLAG line (failing job, run URL). Cancelled runs are listed once as a note:
# they need a re-run, not a fix. Nothing is re-run and no repo is edited.
#   chk-ci-red.sh
#   env: DOT_BOOTSTRAP (else the DOT_BOOTSTRAP line of this repo's .env) locates tools/ci-red.sh and projects.tsv.
#        CI_RED_TOOL overrides the tool path, PROJECTS_TSV the list, CI_RED_TIMEOUT the wait in seconds (0 = none).
# Exit 0 every default branch green, 1 at least one red, 2 unreadable (no tool or list, a repo unknown to GitHub,
# or the tool itself failed, e.g. ssh to the gh box refused).
set -u
here=$(cd "$(dirname "$0")/.." && pwd)
boot=${DOT_BOOTSTRAP:-}
[ -n "$boot" ] || boot=$(sed -n 's/^DOT_BOOTSTRAP=//p' "$here/.env" 2>/dev/null | tail -1)
tool=${CI_RED_TOOL:-${boot:+$boot/tools/ci-red.sh}}
[ -n "$tool" ] && [ -r "$tool" ] || { echo "FLAG ci-unreadable: no ci-red.sh (set DOT_BOOTSTRAP in the host .env or CI_RED_TOOL)"; exit 2; }
[ -n "${PROJECTS_TSV:-}" ] || [ -r "${boot:-/nonexistent}/projects.tsv" ] || { echo "FLAG ci-unreadable: no projects.tsv (set DOT_BOOTSTRAP in the host .env or PROJECTS_TSV)"; exit 2; }

tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
secs=${CI_RED_TIMEOUT:-0}
if [ "$secs" -gt 0 ] 2>/dev/null; then timeout "$secs" bash "$tool" >"$tmp" 2>&1; rc=$?
else bash "$tool" >"$tmp" 2>&1; rc=$?; fi

red=0; unknown=0; cancelled=""
while IFS= read -r line; do
    if [[ $line =~ ^red:\ [0-9]+$ ]]; then continue          # the tool's own count, recomputed below
    elif [[ $line == red:* ]]; then echo "FLAG ci-red: ${line#red: }"; red=$((red + 1))
    elif [[ $line == cancelled:* ]]; then cancelled=${line#cancelled: }
    elif [[ $line == unknown:* ]]; then echo "FLAG ci-unreadable: $line"; unknown=$((unknown + 1))
    else echo "    $line"                                       # diagnostics (ssh, gh) pass through
    fi
done < "$tmp"
[ -n "$cancelled" ] && [ "$cancelled" != none ] && echo "note: cancelled, re-run needed (not a failure): $cancelled"
echo "summary: $red red default branch(es), $unknown unknown repo(s), tool exit $rc"

[ "$red" -gt 0 ] && exit 1
if [ "$unknown" -gt 0 ] || { [ "$rc" -ne 0 ] && [ "$rc" -ne 1 ]; }; then
    [ "$rc" -ne 0 ] && [ "$rc" -ne 1 ] && echo "FLAG ci-unreadable: tool failed with exit $rc"
    exit 2
fi
[ "$rc" -eq 1 ] && { echo "FLAG ci-unreadable: tool reported exit 1 with no red repo"; exit 2; }
exit 0
