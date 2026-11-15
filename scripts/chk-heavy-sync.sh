#!/usr/bin/env bash
# chk-heavy-sync.sh: are all copies of `heavy` still the same code? (nightly check, report only)
# Runs dot-bootstrap tools/check_heavy_sync.sh once per reference copy: the installed /usr/local/bin/heavy,
# the owner copy in nightly-env (bin/heavy), and this repo's scripts/heavy/heavy. Each is compared with the
# dot-bootstrap tools/heavy copy (comments and the private conf fallback are ignored, see that script).
#   chk-heavy-sync.sh
#   env: DOT_BOOTSTRAP (dot-bootstrap checkout; else the DOT_BOOTSTRAP line of this repo's .env), HEAVY_INSTALLED
#        (installed copy), NIGHTLY_ENV (nightly-env checkout). Host paths belong in .env, never in this script.
# Exit 0 all in sync, 1 drift, 2 a copy or the checkout is unreadable. Read-only: it never installs or edits a copy.
# Every drift or unreadable copy prints a FLAG line; file a nightly item (or a note on heavy-copy-drift) for each.
set -u
here=$(cd "$(dirname "$0")/.." && pwd)
boot=${DOT_BOOTSTRAP:-}
[ -n "$boot" ] || boot=$(sed -n 's/^DOT_BOOTSTRAP=//p' "$here/.env" 2>/dev/null | tail -1)
[ -n "$boot" ] || { echo "FLAG heavy-sync: no dot-bootstrap checkout (set DOT_BOOTSTRAP in the host .env)"; exit 2; }
check="$boot/tools/check_heavy_sync.sh"
installed=${HEAVY_INSTALLED:-/usr/local/bin/heavy}
nenv=${NIGHTLY_ENV:-$HOME/stack/nightly-env}
refs=("$installed" "$nenv/bin/heavy" "$here/scripts/heavy/heavy")

[ -r "$check" ] || { echo "FLAG heavy-sync: no check script at $check (fix DOT_BOOTSTRAP)"; exit 2; }
drift=0; unreadable=0; tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
for ref in "${refs[@]}"; do
  HEAVY_COPY="$boot/tools/heavy" bash "$check" "$ref" >"$tmp" 2>&1; rc=$?
  case $rc in
    0) echo "ok: heavy copies in sync with $ref" ;;
    1) drift=$((drift + 1))
       echo "FLAG heavy-drift: $ref differs from dot-bootstrap tools/heavy (the diff follows; the owner copy is nightly-env bin/heavy)"
       sed 's/^/    /' "$tmp" ;;
    *) unreadable=$((unreadable + 1))
       echo "FLAG heavy-unreadable: $ref (exit $rc)"
       sed 's/^/    /' "$tmp" ;;
  esac
done
echo "summary: ${#refs[@]} references, $drift drift, $unreadable unreadable"
[ "$drift" -eq 0 ] && [ "$unreadable" -eq 0 ] && exit 0
[ "$drift" -gt 0 ] && exit 1
exit 2
