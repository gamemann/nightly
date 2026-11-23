#!/usr/bin/env bash
# Migrate a pre-redesign Nightly database to the redesign, in place. Idempotent: running it again changes nothing
# except taking another backup.
#
#   scripts/migrate-live.sh [--db FILE] [--backup-dir DIR] [--roots a:b] [--dry-run]
#
#   --db FILE         the database to migrate (default: $NIGHTLY_DB, else data/nightly.db)
#   --backup-dir DIR  where the backup goes first (default: <db dir>/backup)
#   --roots a:b       repo roots for project seed (default: setting projectRoots)
#   --dry-run         back up and check only; change nothing
#
# Steps:
#   1. A WAL-safe online backup (sqlite3 .backup) to DIR/nightly-pre-redesign-<UTC time>.db, then quick_check on it.
#      This is safe while the old panel is still running. Stop the old panel before step 2.
#   2. lib/bootstrap.mjs adds the redesign's tables and columns (additive only), adds the built-in roles, and
#      creates the admin user. It carries over the old login (authUser/authHash); otherwise it uses
#      NIGHTLY_ADMIN_USER/NIGHTLY_ADMIN_PASSWORD or prints a generated password once. If the old panel ran
#      without a login, ingest stays open (ingestOpen), so existing ingest clients keep working.
#   3. nightly node planet: this machine as the planet node.
#   4. nightly project seed: folders and projects from the repo roots and the repos the data already names.
#   5. A summary: row counts of the old tables before and after (none may drop), users, nodes, folders, projects.
# Restore: stop the panel, then copy the backup over FILE and delete FILE-wal and FILE-shm.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="${NIGHTLY_DB:-$ROOT/data/nightly.db}"
BACKUP_DIR=""
ROOTS=()
DRY=0
while [ $# -gt 0 ]; do
    case "$1" in
        --db) DB="$2"; shift 2 ;;
        --backup-dir) BACKUP_DIR="$2"; shift 2 ;;
        --roots) ROOTS=(--roots "$2"); shift 2 ;;
        --dry-run) DRY=1; shift ;;
        -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
        *) echo "migrate-live: unknown argument $1" >&2; exit 2 ;;
    esac
done

command -v sqlite3 >/dev/null || { echo "migrate-live: sqlite3 is required" >&2; exit 1; }
[ -f "$DB" ] || { echo "migrate-live: no database at $DB" >&2; exit 1; }
DB="$(cd "$(dirname "$DB")" && pwd)/$(basename "$DB")"
BACKUP_DIR="${BACKUP_DIR:-$(dirname "$DB")/backup}"
mkdir -p "$BACKUP_DIR"
say() { echo "[migrate] $*"; }

# The tables the old panel had; their row counts must be the same after the migration.
OLD_TABLES=(Item Note Run Schedule Setting Prompt Release Playtest Message Claim usage_event)
counts() {
    local f="$1" t out=""
    for t in "${OLD_TABLES[@]}"; do
        out+="$t=$(sqlite3 -readonly "$f" "SELECT count(*) FROM \"$t\"" 2>/dev/null || echo -) "
    done
    echo "$out"
}

# 1. Backup first (WAL-safe online backup, never a file copy).
BK="$BACKUP_DIR/nightly-pre-redesign-$(date -u +%Y%m%dT%H%M%SZ).db"
sqlite3 "file:$DB?mode=ro" ".backup '$BK'"
sqlite3 "$BK" 'PRAGMA journal_mode = DELETE' >/dev/null   # one self-contained file, no -wal/-shm beside it
CHECK="$(sqlite3 "$BK" 'PRAGMA quick_check')"
[ "$CHECK" = ok ] || { echo "migrate-live: backup $BK failed quick_check: $CHECK" >&2; exit 1; }
say "backup $BK ($(du -h "$BK" | cut -f1), quick_check ok)"
BEFORE="$(counts "$BK")"
say "before: $BEFORE"
if [ "$DRY" = 1 ]; then say "dry run: nothing changed"; exit 0; fi

export NIGHTLY_DB="$DB"
NIGHTLY=(node --no-warnings "$ROOT/bin/nightly.mjs")

# 2. Schema, roles, the admin user.
node --no-warnings "$ROOT/lib/bootstrap.mjs"
# 3. The planet node.
"${NIGHTLY[@]}" node planet
# 4. Folders and projects.
"${NIGHTLY[@]}" project seed "${ROOTS[@]}"

# 5. Summary.
AFTER="$(counts "$DB")"
say "after:  $AFTER"
for kv in $BEFORE; do
    t="${kv%%=*}"; b="${kv#*=}"; a="$(tr ' ' '\n' <<<"$AFTER" | sed -n "s/^$t=//p")"
    [ "$b" = - ] || [ "$a" -ge "$b" ] || { echo "migrate-live: $t lost rows ($b -> $a); restore from $BK" >&2; exit 1; }
done
say "users: $(sqlite3 -readonly "$DB" "SELECT group_concat(u.username || '(' || r.name || ')', ' ') FROM User u JOIN UserRole ur ON ur.userId = u.id JOIN Role r ON r.id = ur.roleId")"
say "nodes: $(sqlite3 -readonly "$DB" "SELECT group_concat(name || ':' || type, ' ') FROM Node")"
say "folders: $(sqlite3 -readonly "$DB" 'SELECT count(*) FROM Folder'), projects: $(sqlite3 -readonly "$DB" 'SELECT count(*) FROM Project')"
say "done; no old table lost rows"
