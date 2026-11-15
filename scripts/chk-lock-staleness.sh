#!/usr/bin/env bash
# chk-lock-staleness.sh: is every game's addons.lock pin current? (nightly check, report only)
# Thin wrapper: the rule lives in dot-bootstrap tools/check_lock_staleness.sh (one implementation): a pin is flagged
# when it is behind the addon's newest v* tag OR more than N commits behind the addon's main. This script only
# finds the checkout and runs it with --fail. Exit 0 / 1 (a pin is stale) / 2 (unreadable or bad value), passed through.
#   chk-lock-staleness.sh
#   env: DOT_BOOTSTRAP (else the DOT_BOOTSTRAP line of this repo's .env) gives the tool, projects.tsv and the checkouts'
#        parent directory. GAMES_ROOT overrides the checkouts' directory, PROJECTS_TSV the list.
#        LOCK_MAX_BEHIND is N (default 20, 0 disables the distance rule; a bad value exits 2). Host paths belong in .env.
# Tags and commit counts come from the local checkouts, so they are as new as the last fetch.
# Read-only: never edits a lock; a stale pin is bumped with the game's tools/sync-lock.sh.
set -u
here=$(cd "$(dirname "$0")/.." && pwd)
boot=${DOT_BOOTSTRAP:-}
[ -n "$boot" ] || boot=$(sed -n 's/^DOT_BOOTSTRAP=//p' "$here/.env" 2>/dev/null | tail -1)
tool="$boot/tools/check_lock_staleness.sh"
[ -n "$boot" ] && [ -r "$tool" ] || { echo "FLAG lock-unreadable: no check script (set DOT_BOOTSTRAP in the host .env to the dot-bootstrap checkout)"; exit 2; }
args=(--fail --max-behind "${LOCK_MAX_BEHIND:-20}" --projects "${PROJECTS_TSV:-$boot/projects.tsv}" --root "${GAMES_ROOT:-$(dirname "$boot")}")
exec bash "$tool" "${args[@]}"
