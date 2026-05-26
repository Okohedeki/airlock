#!/usr/bin/env bash
#
# concurrency-check.sh — fire N requests at a deployed airlock agent ALL AT ONCE
# and show whether it serves them in parallel (in tandem) or one-at-a-time.
#
#   scripts/concurrency-check.sh [URL] [N]
#
#   URL   base URL of the agent     (default: http://localhost:3000)
#         e.g. https://<name>.trycloudflare.com  or  https://<app>.fly.dev
#   N     simultaneous requests     (default: 6)
#   PROMPT (env)  user content      (default: "what is 23 times 19?")
#
# How to read it: the agent runs up to `cap` requests in parallel (see
# AIRLOCK_MAX_CONCURRENCY) and queues the rest. So when you fire N>cap at once,
# the first `cap` come back fast (they ran together) and later ones take longer
# (they waited their turn) — that staircase in the response times IS the proof
# they ran in tandem. A 429 means the request was shed because the queue was full.

set -euo pipefail

URL="${1:-http://localhost:3000}"; URL="${URL%/}"
N="${2:-6}"
PROMPT="${PROMPT:-what is 23 times 19?}"
BODY="{\"messages\":[{\"role\":\"user\",\"content\":\"$PROMPT\"}]}"

command -v curl >/dev/null 2>&1 || { echo "error: curl not found" >&2; exit 1; }
HAVE_PY=0; command -v python3 >/dev/null 2>&1 && HAVE_PY=1

echo "▸ target:   $URL"
echo "▸ requests: $N (fired simultaneously)"

# 1) ask the agent what its parallel cap is (served free at GET /)
INFO="$(curl -s --max-time 10 "$URL/" || true)"
if [ "$HAVE_PY" = 1 ] && [ -n "$INFO" ]; then
  CAP="$(printf '%s' "$INFO" | python3 -c '
import sys, json
try:
    c = json.load(sys.stdin).get("concurrency")
    print("cap=%s  queue=%s" % (c["max"], c["queue"]) if c else "")
except Exception:
    print("")
' 2>/dev/null || true)"
  [ -n "$CAP" ] && echo "▸ agent reports: $CAP" || echo "▸ agent reports: (no concurrency info — older runtime?)"
fi

# 2) launch all N at once; each writes "req <i> <code> <seconds>"
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
now() { if [ "$HAVE_PY" = 1 ]; then python3 -c 'import time;print(time.time())'; else date +%s; fi; }
START="$(now)"

for i in $(seq 1 "$N"); do
  (
    t="$(curl -s -o /dev/null -w '%{http_code} %{time_total}' --max-time 180 \
          "$URL/v1/chat/completions" -H 'content-type: application/json' -d "$BODY")"
    printf 'req %2d  %s\n' "$i" "$t" >> "$TMP"
  ) &
done
wait
END="$(now)"

# 3) report — sorted by response time so the parallel batches are visible
echo
echo "── responses (sorted by time; equal times = ran together) ──"
sort -k4 -n "$TMP" | awk '{printf "  req %-3s  HTTP %s   %6.2fs\n", $2, $3, $4}'

OK="$(awk '$3==200' "$TMP" | wc -l | tr -d ' ')"
SHED="$(awk '$3==429' "$TMP" | wc -l | tr -d ' ')"
echo "──"
echo "  served (200): $OK    shed (429): $SHED"

if [ "$HAVE_PY" = 1 ] && [ "$OK" -gt 0 ]; then
  python3 - "$TMP" "$START" "$END" "$N" <<'PY'
import sys
tmp, start, end, n = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), int(sys.argv[4])
times = []
for line in open(tmp):
    parts = line.split()
    if len(parts) >= 4 and parts[2] == "200":
        times.append(float(parts[3]))
wall = max(end - start, 1e-6)
fastest = min(times)  # a request that didn't queue ≈ one run's time
serial = fastest * n  # how long N would take strictly one-at-a-time
speedup = serial / wall
print(f"  wall: {wall:.2f}s   fastest run: {fastest:.2f}s   serial would be ~{serial:.2f}s")
print(f"  → ~{speedup:.1f}x faster than serial  (≈ effective parallelism)")
print("  parallel ⇒ wall ≈ a single run; serial ⇒ wall ≈ sum of all runs.")
PY
fi
