#!/usr/bin/env bash
# File a review on the nightly panel (/reviews). Runs anywhere with curl and python3.
#   review-post.sh new     KEY "Title"
#   review-post.sh media   KEY WEAPON FILE --slot filmstrip|clip|audio|image [--variant before|after] [--label L] [--title T]
#                          [--licence L] [--source URL] [--note N] [--waveform W.png]
#   review-post.sh verdict KEY WEAPON good|wrong|clear [--note N]
#   review-post.sh open    KEY        (weapons not yet good, as JSON, with the notes)
#   review-post.sh show    KEY        (every weapon with verdict, note and media)
# Env: QA_URL (default http://x-tmc-dev01:3010), QA_USER / QA_PASSWORD if the panel login is on.
set -euo pipefail
[ $# -ge 2 ] || { sed -n 2,10p "$0"; exit 2; }
url=${QA_URL:-http://x-tmc-dev01:3010}
jar=$(mktemp); body=$(mktemp); trap 'rm -f "$jar" "$body"' EXIT
auth=()
if [ -n "${QA_USER:-}${QA_PASSWORD:-}" ]; then
    curl -fsS -c "$jar" -o /dev/null --data-urlencode "username=${QA_USER:-}" --data-urlencode "password=${QA_PASSWORD:-}" "$url/api/login"
    auth=(-b "$jar")
fi
cmd=$1; shift
case $cmd in
    open) curl -fsS ${auth[@]+"${auth[@]}"} "$url/api/review?key=$1&open=1"; echo; exit ;;
    show) curl -fsS ${auth[@]+"${auth[@]}"} "$url/api/review?key=$1"; echo; exit ;;
esac
python3 -I - "$cmd" "$@" > "$body" <<'PY'
import base64, json, os, sys
cmd, args = sys.argv[1], sys.argv[2:]
pos, opt = [], {}
i = 0
while i < len(args):
    if args[i].startswith("--"):
        opt[args[i][2:]] = args[i + 1]; i += 2
    else:
        pos.append(args[i]); i += 1
b64 = lambda p: base64.b64encode(open(p, "rb").read()).decode()
if cmd == "new":
    p = {"action": "new", "key": pos[0], "title": pos[1]}
elif cmd == "verdict":
    p = {"action": "verdict", "key": pos[0], "weapon": pos[1], "verdict": "" if pos[2] == "clear" else pos[2], "note": opt.get("note", ""), "by": opt.get("by", "christian")}
elif cmd == "media":
    f = pos[2]
    p = {"action": "media", "key": pos[0], "weapon": pos[1], "name": os.path.basename(f), "data": b64(f)}
    for k in ("slot", "variant", "label", "title", "licence", "source", "note", "by"):
        if k in opt: p[k] = opt[k]
    if "waveform" in opt: p["waveform"] = b64(opt["waveform"])
else:
    sys.exit("unknown command " + cmd)
print(json.dumps(p))
PY
curl -fsS ${auth[@]+"${auth[@]}"} -H 'content-type: application/json' --data-binary "@$body" "$url/api/review"
echo
