#!/usr/bin/env bash
# Push a QA result to the nightly panel (/qa). Runs on the game machine: needs curl and python3.
#   qa-post.sh fuzz   GAME path/to/summary.json
#   qa-post.sh visual GAME path/to/log-with-"visual: N/M maps ok" [diff-dir]
#   qa-post.sh suite  GAME path/to/payload.json     (payload in the /api/qa format; kind/game filled in)
# Env: QA_URL (default http://x-tmc-dev01:3010), QA_USER / QA_PASSWORD if the panel login is on,
#      QA_COMMIT (default: git rev-parse HEAD of the current directory).
set -euo pipefail
[ $# -ge 3 ] || { sed -n 2,8p "$0"; exit 2; }
kind=$1 game=$2 file=$3 dir=${4:-}
url=${QA_URL:-http://x-tmc-dev01:3010}
commit=${QA_COMMIT:-$(git rev-parse HEAD 2>/dev/null || true)}
body=$(mktemp); jar=$(mktemp); trap 'rm -f "$body" "$jar"' EXIT
python3 -I - "$kind" "$game" "$file" "$dir" "$commit" > "$body" <<'PY'
import base64, glob, json, os, re, sys
kind, game, file, d, commit = sys.argv[1:6]
if kind == "fuzz":
    s = json.load(open(file))
    fails = [{"name": f"{r['map']} seed {r['seed']}", "repro": r.get("repro", ""),
              "reasons": (r.get("reasons") or []) + (r.get("errors") or [])[:5]} for r in s["runs"] if r.get("failed")]
    p = {"summary": {"total": s["pairs"], "failed": s["failed"]}, "failures": fails}
elif kind == "visual":
    txt = open(file, errors="replace").read()
    m = re.findall(r"visual: (\d+)/(\d+) maps ok", txt)
    if not m:
        sys.exit("no 'visual: N/M maps ok' line in " + file)
    ok, tot = int(m[-1][0]), int(m[-1][1])
    bad = re.findall(r"^map (\S+): FAIL", txt, re.M)
    p = {"summary": {"total": tot, "failed": tot - ok}, "failures": [{"name": b} for b in bad], "attachments": []}
    for png in sorted(glob.glob(os.path.join(d, "*_diff.png")) if d else []):
        p["attachments"].append({"name": os.path.basename(png), "data": base64.b64encode(open(png, "rb").read()).decode()})
else:
    p = json.load(open(file))
p.update(kind=kind, game=game)
if commit:
    p.setdefault("commit", commit)
print(json.dumps(p))
PY
auth=()
if [ -n "${QA_USER:-}${QA_PASSWORD:-}" ]; then
    curl -fsS -c "$jar" -o /dev/null --data-urlencode "username=${QA_USER:-}" --data-urlencode "password=${QA_PASSWORD:-}" "$url/api/login"
    auth=(-b "$jar")
fi
curl -fsS ${auth[@]+"${auth[@]}"} -H 'content-type: application/json' --data-binary "@$body" "$url/api/qa"
echo
