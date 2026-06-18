#!/usr/bin/env bash
# Concurrency / queueing proof against the LIVE PUBLIC URL.
# Worker cap = AIRLOCK_MAX_CONCURRENCY=2, queue = AIRLOCK_MAX_QUEUE=3. The mock model
# sleeps 2s/call so runs overlap. Fire N=8 at once: 2 run, 3 queue (served late), 3 shed (429).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUB="$(cat "$ROOT/PUBLIC_URL.txt")"
OUT="$ROOT/logs/concurrency.md"
N=8
: > "$OUT"
log(){ echo "$@" | tee -a "$OUT"; }

log "# airlock e2e — concurrency, marking & queueing (live public URL)"
log ""
log "**Public URL:** \`$PUB\`  ·  cap=2 queue=3  ·  model delay=2s  ·  $(date -u +%Y-%m-%dT%H:%M:%SZ)"
log ""
log "## Worker reports its own cap (GET /)"
log '```'
curl -s --max-time 10 "$PUB/" | tee -a "$OUT"; log ""; log '```'

log ""
log "## Fire $N requests simultaneously; sample /metrics mid-flight"
log ""
TMP="$(mktemp)"
START=$(python3 -c 'import time;print(time.time())')
for i in $(seq 1 $N); do
  (
    code_time=$(curl -s -o /dev/null -w '%{http_code} %{time_total}' --max-time 60 \
      "$PUB/v1/chat/completions" -H 'content-type: application/json' \
      -d "{\"messages\":[{\"role\":\"user\",\"content\":\"req $i\"}],\"run_id\":\"conc-$i\"}")
    echo "req $i $code_time" >> "$TMP"
  ) &
done
# sample /metrics while the burst is in flight (proves running/queued marking)
log "### /metrics during the burst (running = active, waiting = queued)"
log '```'
for s in 1 2 3 4; do
  sleep 1.2
  m=$(curl -s --max-time 5 "$PUB/metrics")
  echo "t+${s}: $m" | tee -a "$OUT"
done
log '```'
wait
END=$(python3 -c 'import time;print(time.time())')

log ""
log "## Result — sorted by response time (the staircase = ran in batches of 2)"
log '```'
sort -k4 -n "$TMP" | awk '{printf "  %-7s  HTTP %s   %6.2fs\n",$1" "$2,$3,$4}' | tee -a "$OUT"
OK=$(awk '$3==200' "$TMP" | wc -l | tr -d ' ')
SHED=$(awk '$3==429' "$TMP" | wc -l | tr -d ' ')
WALL=$(python3 -c "print(f'{$END-$START:.1f}')")
log "  --"
log "  served(200)=$OK  shed(429)=$SHED  wall=${WALL}s  (serial would be ~$(python3 -c "print($N*2)")s)"
log '```'

log ""
log "## Per-tenant marking under load — each run keeps its own id + tenant"
log '```'
curl -s --max-time 10 "$PUB/v1/runs" | python3 -c '
import sys,json
runs=json.load(sys.stdin)["runs"]
conc=[r for r in runs if r["run_id"].startswith("conc-")]
print(f"{len(conc)} concurrency runs recorded, each with a distinct run_id:")
for r in sorted(conc,key=lambda r:r["run_id"]):
    print(f"  {r[\"run_id\"]:9s} status={r[\"status\"]:7s} steps={r[\"n_steps\"]} started={r[\"started\"]:.2f}")
' | tee -a "$OUT"
log '```'
rm -f "$TMP"
echo "DONE → $OUT"
