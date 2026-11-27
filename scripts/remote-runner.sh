#!/usr/bin/env bash
# Runner for a panel that does not live on the work box (2026-11-27: the panel moved to ph-tmc-dev,
# the repos, Claude accounts and Godot stay on x-tmc-dev). Set NIGHTLY_RUNNER to this file in the
# panel's .env: `nightly exec` starts it as usual, and it runs the `run.sh` script prompt on
# NIGHTLY_RUNNER_HOST over ssh with the same NIGHTLY_* variables. Output streams back into the run
# log; the exit code is the script's. Stop from the panel (SIGTERM to this group) or a dropped
# connection ends the remote process group too: the remote side kills it when ssh's stdin closes.
#   NIGHTLY_RUNNER_HOST=core@10.50.0.112   NIGHTLY_RUNNER_KEY=/home/core/.ssh/x-tmc-dev
#   NIGHTLY_RUNNER_ROOT=/home/core/projects/nightly (the checkout there; default: NIGHTLY_ROOT. Set it when the
#                       panel runs in Docker, where NIGHTLY_ROOT is /app)
set -uo pipefail
host=${NIGHTLY_RUNNER_HOST:?NIGHTLY_RUNNER_HOST is not set (the box that runs the jobs)}
key=${NIGHTLY_RUNNER_KEY:-}
root=${NIGHTLY_RUNNER_ROOT:-${NIGHTLY_ROOT:-$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}}
local_root=${NIGHTLY_ROOT:-$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}

body=$("$local_root/bin/nightly" prompt show "${NIGHTLY_RUNNER_SCRIPT:-run.sh}") || {
    echo "remote-runner: no script prompt ${NIGHTLY_RUNNER_SCRIPT:-run.sh}" >&2
    exit 126
}
b64=$(printf '%s\n' "$body" | base64 -w0)

envs="NIGHTLY_ROOT=$(printf %q "$root")"
for v in NIGHTLY_RUN_ID NIGHTLY_SCHEDULE_ID NIGHTLY_SCHEDULE_NAME NIGHTLY_PROMPT NIGHTLY_INSTRUCTIONS \
    NIGHTLY_MAX_TURNS NIGHTLY_TRIGGER NIGHTLY_MODEL; do
    [ -n "${!v+x}" ] && envs+=" $v=$(printf %q "${!v}")"
done

# Remote: script to a private temp dir, own session (setsid) so one kill takes the whole tree,
# a watcher that kills it once our stdin closes (ssh gone or this runner stopped).
# stdin is saved on fd 3 first: an async list (&) in a non-interactive shell gets /dev/null as stdin.
remote=$(cat <<EOF
exec 3<&0
d=\$(mktemp -d) || exit 126
printf %s $(printf %q "$b64") | base64 -d > "\$d/run.sh" && chmod 700 "\$d/run.sh" || exit 126
cd $(printf %q "$root") || exit 126
setsid -w env $envs "\$d/run.sh" </dev/null 3<&- &
p=\$!
( exec >/dev/null 2>&1; cat <&3; kill -TERM -- -\$p || kill -TERM \$p ) &
w=\$!
wait \$p; rc=\$?
pkill -P \$w 2>/dev/null; kill \$w 2>/dev/null
rm -rf "\$d"
exit \$rc
EOF
)

opts=(-o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=6)
[ -n "$key" ] && opts+=(-i "$key" -o IdentitiesOnly=yes)

# Hold ssh's stdin open with a pipe we own; closing it (this script ending) is the remote stop signal.
exec 3< <(exec sleep 2147483647)
holder=$!
ssh "${opts[@]}" "$host" "bash -c $(printf %q "$remote")" <&3 &
sp=$!
exec 3<&-
cleanup() { kill "$sp" "$holder" 2>/dev/null; wait "$sp" 2>/dev/null; exit 143; }
trap cleanup TERM INT HUP
wait "$sp"
rc=$?
kill "$holder" 2>/dev/null
exit $rc
