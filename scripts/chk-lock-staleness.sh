#!/usr/bin/env bash
# chk-lock-staleness.sh: does every game's addons.lock pin the newest tagged release of each addon? (nightly check, report only)
# For each game in projects.tsv (game-*, mg-*, dot-game-template, dot-server-deploy; not *-maps) that commits an
# addons.lock (origin/main, else HEAD), every pin "repo<TAB>ref" is compared with the newest v* tag of that addon's
# sibling checkout (sort -V, the rule of dot-game-template tools/check-lock.sh). A pin behind that tag, or a pin that
# is not a release tag at all (main), prints a FLAG line. requires.floor.json is not checked here: it is a minimum
# API level, not a pin, and check_pushed_floors.sh in dot-bootstrap covers it.
#   chk-lock-staleness.sh
#   env: DOT_BOOTSTRAP (else the DOT_BOOTSTRAP line of this repo's .env) gives projects.tsv and the checkouts' parent
#        directory. GAMES_ROOT overrides the checkouts' directory, PROJECTS_TSV the list. Host paths belong in .env.
# Tags are read from the local checkouts, so they are as new as the last fetch (sync_checkouts.sh keeps them fresh).
# Exit 0 no pin behind, 1 at least one pin behind, 2 unreadable (no list, no checkout root, or a pinned addon not checked out).
# Read-only: never edits a lock; a stale pin is bumped with the game's tools/sync-lock.sh.
set -u
here=$(cd "$(dirname "$0")/.." && pwd)
boot=${DOT_BOOTSTRAP:-}
[ -n "$boot" ] || boot=$(sed -n 's/^DOT_BOOTSTRAP=//p' "$here/.env" 2>/dev/null | tail -1)
tsv=${PROJECTS_TSV:-${boot:+$boot/projects.tsv}}
root=${GAMES_ROOT:-${boot:+$(dirname "$boot")}}
[ -n "$tsv" ] && [ -r "$tsv" ] || { echo "FLAG lock-unreadable: no projects.tsv (set DOT_BOOTSTRAP in the host .env or PROJECTS_TSV)"; exit 2; }
[ -n "$root" ] && [ -d "$root" ] || { echo "FLAG lock-unreadable: no checkout directory (set DOT_BOOTSTRAP in the host .env or GAMES_ROOT)"; exit 2; }

games=$(grep -v '^[[:space:]]*#' "$tsv" | cut -f1 | grep -E '^((game|mg)-|dot-game-template$|dot-server-deploy$)' | grep -v -- '-maps$')
stale=0; unreadable=0; games_locked=0; pins=0
for g in $games; do
    gd="$root/$g"
    [ -e "$gd/.git" ] || { echo "skip: $g is not checked out"; continue; }
    ref=origin/main; git -C "$gd" rev-parse -q --verify "$ref" >/dev/null 2>&1 || ref=HEAD
    lock=$(git -C "$gd" show "$ref:addons.lock" 2>/dev/null) || { echo "skip: $g commits no addons.lock"; continue; }
    games_locked=$((games_locked + 1))
    while IFS=$'\t' read -r repo have; do
        case "$repo" in ''|'#'*) continue ;; esac
        [ -n "$have" ] || continue
        pins=$((pins + 1))
        rd="$root/$repo"
        if [ ! -e "$rd/.git" ]; then
            echo "FLAG lock-unreadable: $g pins $repo $have, $repo is not checked out"; unreadable=$((unreadable + 1)); continue
        fi
        newest=$(git -C "$rd" tag --list 'v*' | sort -V | tail -1)
        [ -n "$newest" ] || continue            # the addon has no release tag yet: nothing to be behind
        [ "$have" = "$newest" ] && continue
        case "$have" in
            v*) lower=$(printf '%s\n%s\n' "$have" "$newest" | sort -V | head -1)
                [ "$lower" = "$have" ] || continue ;;   # pin ahead of the local tags: a stale checkout, not a stale pin
            *)  ;;                                      # not a release tag (main or a branch): behind by definition
        esac
        echo "FLAG lock-behind: $g pins $repo $have, newest tag $newest"
        stale=$((stale + 1))
    done <<< "$lock"
done
echo "summary: $games_locked game lock(s), $pins pin(s), $stale behind, $unreadable unreadable"
[ "$stale" -gt 0 ] && exit 1
[ "$unreadable" -gt 0 ] && exit 2
exit 0
