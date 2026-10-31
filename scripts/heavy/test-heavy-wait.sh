#!/usr/bin/env bash
# Tests heavy's slot/memory order and --max-wait using a fake cgroup (HEAVY_CGROUP) and HEAVY_DIR.
H=${1:-$(dirname "$0")/heavy}; T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; fail=0
cg=$T/cg; mkdir $cg; echo 1000000000 > $cg/memory.max; echo 999000000 > $cg/memory.current  # ~1 MB free
export HEAVY_CGROUP=$cg HEAVY_DIR=$T/d HEAVY_MIN_AVAIL_GB=3 HEAVY_JOB_MAX_GB=0 HEAVY_OFFLOAD= GPU_OFFLOAD=0 HEAVY_HELD=
unset HEAVY_HELD
ck(){ if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1 (got $2, want $3)"; fail=1; fi; }
"$H" --max-wait 2 --lane check -- true 2>$T/err; ck "gives up with exit 124" $? 124
grep -q "gave up" $T/err; ck "prints give-up line" $? 0
# while a job waits for memory, its slot must be free
HEAVY_MAX_WAIT=6 "$H" --lane check -- true 2>/dev/null & p=$!
sleep 2; busy=0
for f in $T/d/check.*.lock; do flock -n $f true || busy=1; done
ck "waiting job holds no slot" $busy 0
wait $p; ck "env HEAVY_MAX_WAIT works" $? 124
echo 10000000000 > $cg/memory.max; echo 0 > $cg/memory.current
HEAVY_MIN_AVAIL_GB=1 "$H" --max-wait 2 --lane check -- sh -c 'exit 7'; ck "runs and passes exit code when memory free" $? 7
"$H" --max-wait x -- true 2>/dev/null; ck "bad value rejected" $? 64
exit $fail
