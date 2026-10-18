#!/usr/bin/env bash
# Install the memory guard on this VM, or on another one: `install.sh [--remote HOST]`.
# Idempotent; rerun after changing anything here. See README.md for why each piece exists.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)

if [ "${1:-}" = "--remote" ]; then
  host=$2; key=${3:-$HOME/.ssh/dev02}
  ssh -i "$key" "$host" 'rm -rf ~/.cache/heavy-install && mkdir -p ~/.cache/heavy-install'
  scp -q -i "$key" "$here"/heavy "$here"/heavy-gate.py "$here"/heavy-smoke.py "$here"/install.sh "$host":.cache/heavy-install/
  exec ssh -i "$key" "$host" 'bash ~/.cache/heavy-install/install.sh'
fi

# Per-VM budget. MemoryMax caps everything Christian's user runs (VS Code, Claude sessions, the
# nightly panel and its agents, dev servers, builds); system services stay outside it. A job
# that overshoots is OOM-killed inside the guest instead of the host killing the whole VM.
case $(hostname -s) in
  x-tmc-dev01) high=20G max=22G avail=5 job=18 ch=5000000000 builds=1 extra=5 ;;   # 31 GB guest; ClickHouse, Postgres, Redis outside
  x-tmc-dev02) high=8G  max=9G  avail=3 job=7  ch= builds=2 extra=5 ;;  # 12 GB guest; build slot 2 only with 5 GB free
  *) echo "install.sh: no budget for $(hostname -s); add one" >&2; exit 1 ;;
esac

# The wrapper and the hook. On the machine that holds the repo they are symlinks, so an edit
# here is live; elsewhere they are copies (rerun with --remote after a change).
if [ -d "$HOME/stack/nightly/scripts/heavy" ] && [ "$here" = "$HOME/stack/nightly/scripts/heavy" ]; then
  sudo ln -sfn "$here/heavy" /usr/local/bin/heavy
  mkdir -p ~/.claude/hooks && ln -sfn "$here/heavy-gate.py" ~/.claude/hooks/heavy-gate.py
else
  sudo install -m 755 "$here/heavy" /usr/local/bin/heavy
  sudo install -m 755 "$here/heavy-smoke.py" /usr/local/bin/heavy-smoke.py
  mkdir -p ~/.claude/hooks && install -m 755 "$here/heavy-gate.py" ~/.claude/hooks/heavy-gate.py
  install -m 755 "$here/heavy-smoke.py" ~/.claude/hooks/heavy-smoke.py
fi
printf 'HEAVY_SLOTS_BUILD=%s\nHEAVY_SLOTS_CHECK=2\nHEAVY_MIN_AVAIL_GB=%s\nHEAVY_EXTRA_AVAIL_GB=%s\nHEAVY_JOB_MAX_GB=%s\n' "$builds" "$avail" "$extra" "$job" | sudo tee /etc/heavy.conf >/dev/null

python3 - <<'PY'
import json, os
p = os.path.expanduser("~/.claude/settings.json")
s = json.load(open(p)) if os.path.exists(p) else {}
pre = s.setdefault("hooks", {}).setdefault("PreToolUse", [])
cmd = "python3 ~/.claude/hooks/heavy-gate.py"
if not any(h.get("command") == cmd for e in pre for h in e.get("hooks", [])):
    pre.append({"matcher": "Bash", "hooks": [{"type": "command", "command": cmd, "timeout": 10}]})
    json.dump(s, open(p, "w"), indent=2); open(p, "a").write("\n")
PY

sudo systemctl set-property user-1000.slice MemoryHigh=$high MemoryMax=$max

if [ -n "$ch" ] && sudo test -d /etc/clickhouse-server/config.d; then   # dir is 0500 clickhouse: test as root
  # ClickHouse defaults to 90% of RAM; on a 38 GB guest that alone could fill it.
  f=/etc/clickhouse-server/config.d/memory-cap.xml
  want="<clickhouse><max_server_memory_usage>$ch</max_server_memory_usage></clickhouse>"
  if [ "$(sudo cat $f 2>/dev/null)" != "$want" ]; then
    echo "$want" | sudo tee $f >/dev/null && sudo systemctl restart clickhouse-server
  fi
fi

echo "$(hostname -s): heavy $(command -v heavy), hook installed, user-1000.slice High=$high Max=$max, start needs ${avail} GB free${ch:+, ClickHouse capped at $((ch/1000000000)) GB}"
