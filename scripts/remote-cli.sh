#!/usr/bin/env bash
# Client mode of bin/nightly: the database lives on another host (2026-11-27: the panel moved to
# ph-tmc-dev), so this runs the same command there over ssh. bin/nightly execs this when
# /etc/nightly/remote.env (or $NIGHTLY_REMOTE_FILE) exists and NIGHTLY_LOCAL is not 1.
#
# remote.env (no secrets, world-readable):
#   NIGHTLY_REMOTE_HOST=core@10.40.0.127      ssh target that owns the checkout + data
#   NIGHTLY_REMOTE_KEY=/home/core/.ssh/ph     identity file (callers that cannot read it re-exec as
#   NIGHTLY_REMOTE_USER=core                  this user through sudo -n)
#   NIGHTLY_REMOTE_ROOT=/home/core/projects/nightly   checkout on the remote (default: same as here)
#
# Files named by file-taking flags (--body-file, --file, ...) and the file arguments of attach /
# perf shot add / review media are copied to a temp dir on the remote first and the argument is
# rewritten. Directory arguments (--out, --root, --dir) are not mirrored: they name remote paths.
set -euo pipefail
conf=$1
shift
# shellcheck disable=SC1090
. "$conf"
here=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
host=${NIGHTLY_REMOTE_HOST:?nightly: NIGHTLY_REMOTE_HOST missing in $conf}
key=${NIGHTLY_REMOTE_KEY:-}
ruser=${NIGHTLY_REMOTE_USER:-core}
root=${NIGHTLY_REMOTE_ROOT:-$here}

# Variables the CLI reads that belong to the caller, not to the remote's .env.
pass_vars=(NIGHTLY_RUN_ID NIGHTLY_SCHEDULE_ID NIGHTLY_SCHEDULE_NAME NIGHTLY_TRIGGER NIGHTLY_CLI_TIMEOUT
    NIGHTLY_TICK_TIMEOUT NIGHTLY_LONG_TIMEOUT NIGHTLY_TICK_SOURCE NIGHTLY_NO_AUTO_THUMBS)

if [ -n "$key" ] && [ ! -r "$key" ] && [ "$(id -un)" != "$ruser" ]; then
    envs=()
    for v in "${pass_vars[@]}"; do [ -n "${!v+x}" ] && envs+=("$v=${!v}"); done
    exec sudo -n -u "$ruser" env "${envs[@]}" NIGHTLY_REMOTE_FILE="$conf" "$here/bin/nightly" "$@"
fi

ctl=${XDG_RUNTIME_DIR:-/tmp}
[ -w "$ctl" ] || ctl=/tmp
ssh_opts=(-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=30 -o ServerAliveCountMax=4
    -o ControlMaster=auto -o "ControlPath=$ctl/nightly-ssh-$(id -u)-%C" -o ControlPersist=120)
[ -n "$key" ] && ssh_opts+=(-i "$key" -o IdentitiesOnly=yes)

cmd=${1:-}
sub=${2:-}
file_flag() {
    case $1 in --body-file | --file | --report-file | --folded | --waveform) return 0 ;; esac
    return 1
}
positional_files=0
case $cmd in attach | review) positional_files=1 ;; perf) [ "$sub" = shot ] && positional_files=1 ;; esac

uploads=()
args=()
remote_tmp=/tmp/nightly-up.$$.$RANDOM
prev=""
newarg() { # $1 = local file -> $up = its remote path; records the upload (no subshell: uploads must persist)
    uploads+=("$1")
    up="$remote_tmp/${#uploads[@]}/$(basename -- "$1")"
}
for a in "$@"; do
    if [[ $a == --*=* ]] && file_flag "${a%%=*}" && [ -f "${a#*=}" ]; then
        newarg "${a#*=}"
        args+=("${a%%=*}=$up")
    elif { file_flag "$prev" || [ $positional_files = 1 ]; } && [[ $a != -* ]] && [ -f "$a" ]; then
        newarg "$a"
        args+=("$up")
    else
        args+=("$a")
    fi
    prev=$a
done

remote_env="NIGHTLY_LOCAL=1"
for v in "${pass_vars[@]}"; do
    [ -n "${!v+x}" ] && remote_env+=" $v=$(printf %q "${!v}")"
done
qargs=""
for a in "${args[@]+"${args[@]}"}"; do qargs+=" $(printf %q "$a")"; done
qroot=$(printf %q "$root")

# stdin: the CLI reads it with readFileSync(0), which gives up (EAGAIN) when nothing is there yet. Over ssh
# that race is lost every time, so pass stdin only if it has data (or EOF) now, as a file on the remote;
# otherwise /dev/null (what the local CLI would have read too). A caller whose stdin never closes stays safe.
feed=""
if [ ! -t 0 ] && read -r -t 0 -u 0 2>/dev/null; then
    feed=1
fi
in_redirect=""
[ -n "$feed" ] && in_redirect=' < "$t"'
run="env $remote_env $qroot/bin/nightly$qargs$in_redirect"
[ -n "$feed" ] && run="t=\$(mktemp) && cat > \"\$t\" && { $run; rc=\$?; rm -f \"\$t\"; (exit \$rc); }"

if [ ${#uploads[@]} -gt 0 ]; then
    stage=$(mktemp -d)
    trap 'rm -rf "$stage"' EXIT
    i=0
    for f in "${uploads[@]}"; do
        i=$((i + 1))
        mkdir -p "$stage/$i"
        cp -- "$f" "$stage/$i/"
    done
    tar -C "$stage" -cf - . | ssh "${ssh_opts[@]}" "$host" "mkdir -p $remote_tmp && tar -C $remote_tmp -xf -"
    remote="cd $qroot && { $run; }; rc=\$?; rm -rf $remote_tmp; exit \$rc"
else
    remote="cd $qroot && { $run; }"
fi

nflag=()
[ -z "$feed" ] && nflag=(-n)
limit=0
case $cmd in
    exec) limit=0 ;;
    *) limit=$((${NIGHTLY_CLI_TIMEOUT:-60} + 30))
       case $cmd in assets | rsi) case $sub in scan | refresh) limit=$((${NIGHTLY_LONG_TIMEOUT:-3600} + 30)) ;; esac ;; esac ;;
esac
if [ "$limit" != 0 ] && command -v timeout >/dev/null 2>&1; then
    timeout --kill-after=5 "$limit" ssh "${nflag[@]}" "${ssh_opts[@]}" "$host" "$remote"
else
    ssh "${nflag[@]}" "${ssh_opts[@]}" "$host" "$remote"
fi
