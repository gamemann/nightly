#!/usr/bin/env bash
# Install the nightly node daemon on this machine. Idempotent: run it again to change settings or repair a
# half-finished install; an existing token is kept.
#
#   install-node.sh --planet  [options]   the machine the panel and the agents live on
#   install-node.sh --station [options]   an offload box: runs jobs for the panel and nothing else
#   install-node.sh --uninstall [--purge]
#
# Options
#   --name NAME         node name shown in the panel (default: short hostname)
#   --port PORT         daemon port (default 4001)
#   --token TOKEN       shared token (default: keep the installed one, else generate)
#   --kinds a,b,c       offload kinds (build,test,suite,gpu,browser,perf,map-convert; default: what the probe suggests)
#   --workspaces a,b    directories jobs may run in
#   --tls               create a self-signed certificate and serve wss
#   --panel             also install the panel as a system service (planet only)
#   --user USER         account the daemon runs as (default: the invoking user, or nightly when run as root)
#   --prefix DIR        install under DIR instead of / (staging and tests; skips systemctl)
#   --no-systemd        do not install or start units
#   --dry-run           print what would be done
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
mode="" uninstall=0 purge=0 name="" port=4001 token="" kinds="" workspaces="" tls=0 panel=0 user="" prefix="" systemd=1 dry=0

die() { echo "install-node: $*" >&2; exit 1; }
say() { echo "install-node: $*"; }
run() { if [ "$dry" = 1 ]; then echo "+ $*"; else "$@"; fi; }
is_root() { [ "$(id -u)" = 0 ]; }

while [ $# -gt 0 ]; do
    case $1 in
        --planet) mode=planet ;;
        --station) mode=station ;;
        --uninstall) uninstall=1 ;;
        --purge) purge=1 ;;
        --name) name=${2:?--name needs a value}; shift ;;
        --port) port=${2:?--port needs a value}; shift ;;
        --token) token=${2:?--token needs a value}; shift ;;
        --kinds) kinds=${2:?--kinds needs a value}; shift ;;
        --workspaces) workspaces=${2:?--workspaces needs a value}; shift ;;
        --tls) tls=1 ;;
        --panel) panel=1 ;;
        --user) user=${2:?--user needs a value}; shift ;;
        --prefix) prefix=${2:?--prefix needs a value}; shift ;;
        --no-systemd) systemd=0 ;;
        --dry-run) dry=1 ;;
        -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) die "unknown option $1 (try --help)" ;;
    esac
    shift
done
if [ "$uninstall" = 0 ] && [ -z "$mode" ]; then die "choose --planet or --station (or --uninstall)"; fi
if [ "$panel" = 1 ] && [ "$mode" != planet ]; then die "--panel only makes sense with --planet"; fi
if ! [[ $port =~ ^[0-9]+$ ]] || [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then die "--port must be 1-65535"; fi
if [ -n "$prefix" ]; then systemd=0; fi

if [ -z "$user" ]; then
    if is_root; then user=${SUDO_USER:-nightly}; else user=$(id -un); fi
fi
home=$(getent passwd "$user" | cut -d: -f6 || true)
if [ -z "$home" ]; then home=/home/$user; fi
if [ -n "$prefix" ] && ! is_root; then home=${HOME:-$home}; fi
name=${name:-$(hostname -s)}

etc=$prefix/etc/nightly-node
envfile=$etc/env
bindir=$prefix/usr/local/bin
unitdir=$prefix/etc/systemd/system
state=$home/.nightly-node

if [ -z "$prefix" ] && [ "$dry" = 0 ] && ! is_root; then die "run as root (sudo), or use --prefix to stage"; fi

link() { # link TARGET DEST: replace a symlink, never clobber a real file
    local target=$1 dest=$2
    if [ -e "$dest" ] && [ ! -L "$dest" ]; then say "keeping existing file $dest"; return 0; fi
    run mkdir -p "$(dirname "$dest")"
    run ln -sfn "$target" "$dest"
}

own() { if [ "$dry" = 0 ] && is_root; then chown "$user" "$@" 2>/dev/null || true; fi; }

if [ "$uninstall" = 1 ]; then
    if [ "$systemd" = 1 ]; then
        for u in nightly-node nightly-panel; do
            if [ -f "$unitdir/$u.service" ]; then run systemctl disable --now "$u" || true; fi
        done
    fi
    run rm -f "$unitdir/nightly-node.service" "$unitdir/nightly-panel.service"
    if [ "$systemd" = 1 ]; then run systemctl daemon-reload || true; fi
    for l in "$bindir"/*; do
        [ -L "$l" ] || continue
        case $(readlink "$l") in "$root"/*) run rm -f "$l" ;; esac
    done
    run rm -f "$envfile" "$etc/tls.crt" "$etc/tls.key"
    run rmdir "$etc" 2>/dev/null || true
    if [ "$purge" = 1 ]; then run rm -rf "$state"; fi
    say "removed (the repository is untouched; node state in $state is kept unless --purge)"
    exit 0
fi

command -v node >/dev/null 2>&1 || die "node not found; install Node 22 or newer first"
if [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then die "Node 22 or newer is required"; fi

# Token: explicit, else the one already installed, else a new random one.
if [ -z "$token" ] && [ -f "$envfile" ]; then token=$(sed -n 's/^NIGHTLY_NODE_TOKEN=//p' "$envfile" | head -n1); fi
if [ -z "$token" ]; then token=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'); fi

run mkdir -p "$etc" "$bindir"
cert="" key=""
if [ "$tls" = 1 ]; then
    cert=$etc/tls.crt key=$etc/tls.key
    if [ ! -f "$cert" ]; then
        command -v openssl >/dev/null 2>&1 || die "--tls needs openssl"
        run openssl req -x509 -newkey rsa:3072 -nodes -days 3650 -subj "/CN=$name" -keyout "$key" -out "$cert" 2>/dev/null
        run chmod 600 "$key"
        own "$cert" "$key"
    fi
fi

if [ "$dry" = 1 ]; then
    echo "+ write $envfile (mode=$mode name=$name port=$port token=<hidden>)"
else
    tmp=$(mktemp "$etc/.env.XXXXXX")
    {
        echo "# written by install/install-node.sh; rerun it to change"
        echo "NIGHTLY_NODE_MODE=$mode"
        echo "NIGHTLY_NODE_NAME=$name"
        echo "NIGHTLY_NODE_PORT=$port"
        echo "NIGHTLY_NODE_TOKEN=$token"
        echo "NIGHTLY_NODE_STATE=$state"
        if [ -n "$kinds" ]; then echo "NIGHTLY_NODE_KINDS=$kinds"; fi
        if [ -n "$workspaces" ]; then echo "NIGHTLY_NODE_WORKSPACES=$workspaces"; fi
        if [ -n "$cert" ]; then echo "NIGHTLY_NODE_TLS_CERT=$cert"; echo "NIGHTLY_NODE_TLS_KEY=$key"; fi
        if [ "$mode" != planet ]; then echo "NIGHTLY_NODE_ALLOW_USER_CREATE=false"; fi
    } >"$tmp"
    chmod 600 "$tmp"
    own "$tmp" "$etc"
    mv -f "$tmp" "$envfile"
fi
run mkdir -p "$state"
if [ "$dry" = 0 ]; then chmod 700 "$state"; own "$state"; fi

link "$root/bin/nightly-node" "$bindir/nightly-node"

if [ "$mode" = planet ]; then
    link "$root/bin/nightly" "$bindir/nightly"
    # The nightly-env scripts (heavy, claude-acct, ...) from a checkout, else this repository's own copies.
    envdir=${NIGHTLY_ENV:-$home/stack/nightly-env}
    if [ -d "$envdir/bin" ]; then
        for f in "$envdir"/bin/*; do
            if [ -f "$f" ] && [ -x "$f" ]; then link "$f" "$bindir/$(basename "$f")"; fi
        done
    else
        say "no nightly-env checkout at $envdir (set NIGHTLY_ENV); linking the copies in this repository"
        link "$root/scripts/heavy/heavy" "$bindir/heavy"
        link "$root/scripts/claude-acct" "$bindir/claude-acct"
    fi
    # One directory per Claude subscription, created empty; `nightly account add NAME` fills them.
    acct=${CLAUDE_ACCT_DIR:-$home/.claude-accounts}
    run mkdir -p "$acct"
    if [ "$dry" = 0 ]; then chmod 700 "$acct"; own "$acct"; fi
fi

if [ "$systemd" = 1 ]; then
    nnp=true
    if [ "$mode" = planet ]; then nnp=false; fi
    if [ "$dry" = 1 ]; then
        echo "+ install $unitdir/nightly-node.service"
    else
        mkdir -p "$unitdir"
        sed -e "s|@@ROOT@@|$root|g" -e "s|@@USER@@|$user|g" -e "s|@@ENVFILE@@|$envfile|g" -e "s|@@MODE@@|$mode|g" -e "s|@@NNP@@|$nnp|g" \
            "$root/deploy/nightly-node.service" >"$unitdir/nightly-node.service"
        if [ "$panel" = 1 ]; then
            sed -e "s|%h/stack/nightly|$root|g" -e "s|^WantedBy=default.target|WantedBy=multi-user.target|" \
                -e "s|^\[Service\]|[Service]\nUser=$user|" "$root/deploy/nightly-panel.service" >"$unitdir/nightly-panel.service"
        fi
    fi
    run systemctl daemon-reload
    run systemctl enable nightly-node
    run systemctl restart nightly-node
    if [ "$panel" = 1 ]; then run systemctl enable nightly-panel; run systemctl restart nightly-panel; fi
fi

say "$mode '$name' installed; daemon port $port, config $envfile"
say "add it in the panel (Nodes): host <this machine>, port $port; the token is in $envfile (readable by $user only)"
