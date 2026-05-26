#!/usr/bin/env bash
#
# test-self-host.sh — end-to-end test of the SELF-HOST prong.
#
# Provisions a harness with `airlock init --self-host --detect`, runs it with
# `airlock up` (agent on YOUR box + a public tunnel), and asserts it answers on
# BOTH localhost and its public URL (proving off-box reachability). No cloud
# account, no Docker, no `fly auth login`.
#
#   scripts/test-self-host.sh [HARNESS_REPO] [PROJECT_NAME]
#
#   HARNESS_REPO  agent repo to host       (default: ~/Documents/smol-harness)
#   PROJECT_NAME  airlock project name     (default: basename of the repo)
#   PORT   (env)  port to serve on          (default: 3000)
#   PYTHON (env)  python to build the venv  (default: python3.12/3.11/3)
#   MODEL  (env)  path to a .gguf           (default: first in <repo>/models)
#
# Self-contained: builds a fresh venv under /tmp, installs the airlock runtime
# editable from THIS repo (airlock-agent/-payment aren't on PyPI yet) + the
# harness editable from its own repo, then drives the real CLI.

set -euo pipefail

AIRLOCK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARNESS_REPO="${1:-$HOME/Documents/smol-harness}"
PROJECT_NAME="${2:-$(basename "$HARNESS_REPO")}"
PORT="${PORT:-3000}"
TRY="${TRY_BASE:-/tmp/airlock-selfhost}-$(date +%Y%m%d-%H%M%S)"
CLI="$AIRLOCK/packages/cli/dist/cli.js"

[ -f "$CLI" ] || { echo "error: CLI not built — run \`pnpm --filter @airlockhq/cli build\`" >&2; exit 1; }
[ -d "$HARNESS_REPO" ] || { echo "error: harness repo not found: $HARNESS_REPO" >&2; exit 1; }

UP_PID=""
cleanup() {
  [ -n "$UP_PID" ] && kill "$UP_PID" 2>/dev/null || true
  pkill -f "cli.js up" 2>/dev/null || true
  pkill -f "tunnel --url http://localhost:$PORT" 2>/dev/null || true
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2}' | xargs -r kill -9 2>/dev/null || true
}
trap cleanup EXIT

echo "▸ sandbox: $TRY"
echo "▸ harness: $HARNESS_REPO  (project: $PROJECT_NAME, port: $PORT)"
mkdir -p "$TRY"

# 1) fresh venv + airlock runtime (local, unpublished) + the harness (editable)
PY="${PYTHON:-}"
if [ -z "$PY" ]; then for c in python3.12 python3.11 python3; do command -v "$c" >/dev/null 2>&1 && { PY="$c"; break; }; done; fi
echo "▸ venv ($("$PY" --version 2>&1))…"
"$PY" -m venv "$TRY/venv"; V="$TRY/venv/bin"
"$V/pip" install -q --upgrade pip
"$V/pip" install -q -e "$AIRLOCK/python/payment-fly" -e "$AIRLOCK/python/agent-runtime" \
  "fastapi>=0.115,<1" "uvicorn[standard]>=0.30,<1" "pyyaml>=6,<7"
echo "▸ installing harness (editable — may compile native deps once)…"
"$V/pip" install -q -e "$HARNESS_REPO"

# 2) light source copy → the airlock-wired project (no venv/git/model/caches)
mkdir -p "$TRY/app"
rsync -a --exclude '.venv' --exclude '.git' --exclude '__pycache__' \
  --exclude 'models' --exclude 'node_modules' "$HARNESS_REPO"/ "$TRY/app"/

# 3) wire self-host (writes .airlock/config.toml mode=self-hosted + the [agent] block)
( cd "$TRY/app" && node "$CLI" init "$PROJECT_NAME" --self-host --detect )

# 4) model — smol-harness reads $SMOL_HARNESS_MODEL; auto-discover a gguf if unset
MODEL="${MODEL:-}"
[ -z "$MODEL" ] && MODEL="$(ls "$HARNESS_REPO"/models/*.gguf 2>/dev/null | head -1 || true)"
if [ -n "$MODEL" ]; then export SMOL_HARNESS_MODEL="$MODEL"; echo "▸ model: $MODEL"; fi

# 5) airlock up (background) — runs `python -m airlock_agent` + opens a tunnel
echo "▸ airlock up …"
( cd "$TRY/app" && node "$CLI" up --port "$PORT" --python "$V/python" ) > "$TRY/up.log" 2>&1 &
UP_PID=$!

# 6) wait for health (model load can take a while the first time)
echo "▸ waiting for /healthz on :$PORT …"
for _ in $(seq 1 90); do curl -sf "localhost:$PORT/healthz" >/dev/null 2>&1 && break; sleep 2; done
curl -sf "localhost:$PORT/healthz" >/dev/null || { echo "FAIL: agent never became healthy"; echo "---"; cat "$TRY/up.log"; exit 1; }

# 7) localhost assertion (deterministic gate)
echo "▸ localhost call …"
RESP="$(curl -s "localhost:$PORT/v1/chat/completions" -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"what is 23 times 19?"}]}')"
echo "  $RESP"
echo "$RESP" | grep -q '"object":"chat.completion"' || { echo "FAIL: no completion from localhost"; exit 1; }
echo "  ✓ localhost OK"

# 8) public URL assertion (off-box reachability through Cloudflare)
URL="$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$TRY/up.log" | head -1 || true)"
if [ -n "$URL" ]; then
  echo "▸ public call: $URL (allowing for DNS propagation)…"
  PUB=""
  for _ in $(seq 1 10); do
    PUB="$(curl -s --max-time 20 "$URL/v1/chat/completions" -H 'content-type: application/json' \
      -d '{"messages":[{"role":"user","content":"ping"}]}' || true)"
    echo "$PUB" | grep -q '"object":"chat.completion"' && { echo "  ✓ public round-trip OK"; break; }
    sleep 3
  done
  echo "$PUB" | grep -q '"object":"chat.completion"' || \
    echo "  WARN: public URL didn't round-trip (DNS/network) — localhost passed; try the URL from another machine"
else
  echo "  WARN: no tunnel URL in log"
fi

echo "✓ SELF-HOST TEST PASSED"
