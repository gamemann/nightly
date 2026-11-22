#!/usr/bin/env bash
# Restart the web panel after a deploy (git merge, `npx prisma generate`, `npm run build`).
# The panel has no systemd unit on this box: it is `npm start` (next start, port 3010) owned by the user that checked the repo out
# (core). This script stops whatever listens on the port and starts a fresh `npm start` detached, logging to data/panel.log.
# Runs the scheduler started are separate detached processes and keep going; only the panel's own scheduler tick pauses.
#   scripts/restart-panel.sh            restart
#   scripts/restart-panel.sh --stop     stop only
# Env: NIGHTLY_PORT (default 3010). Run it as the owner of the checkout; from another user it re-executes itself via sudo -u <owner>.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${NIGHTLY_PORT:-3010}"
OWNER_USER="$(stat -c %U .)"
if [ "$(id -un)" != "$OWNER_USER" ]; then exec sudo -u "$OWNER_USER" "$0" "$@"; fi

pid="$(ss -ltnpH "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true)"
if [ -n "$pid" ]; then
    echo "stopping panel pid $pid"
    kill "$pid"
    for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill -0 "$pid" 2>/dev/null && { echo "pid $pid ignored SIGTERM, killing"; kill -9 "$pid"; sleep 1; }
fi
[ "${1:-}" = "--stop" ] && exit 0

mkdir -p data
nohup setsid npm start >> data/panel.log 2>&1 < /dev/null &
for _ in $(seq 1 30); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/"; then echo "panel up on :$PORT (log data/panel.log)"; exit 0; fi
    sleep 1
done
echo "panel did not answer on :$PORT within 30 s; see data/panel.log" >&2
exit 1
