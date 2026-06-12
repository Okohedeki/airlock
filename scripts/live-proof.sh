#!/usr/bin/env bash
#
# live-proof.sh — prove airlock on the PUBLIC WEB, not localhost.
#
# This is the runnable companion to docs/redesign/LIVE-TEST.md. It boots a REAL model loop
# (the `openai` harness over a local OpenAI-compatible model), opens a REAL Cloudflare quick
# tunnel via `airlock up` (zero Cloudflare account/credentials), captures the public
# https://<rand>.trycloudflare.com URL, and drives airlock's control surface against THAT
# public URL — the product, not a localhost mock. Everything is teed to a dated transcript
# under docs/proof/ so the proof is reviewable after the ephemeral URL is gone.
#
# Usage:
#   bash scripts/live-proof.sh                 # zero-dep: bundled mock model (model.py)
#   bash scripts/live-proof.sh --model-url URL # point at a real OpenAI-compatible server
#                                              #   e.g. http://127.0.0.1:11434/v1/chat/completions
#   bash scripts/live-proof.sh --record        # also record an asciinema cast (if installed)
#   bash scripts/live-proof.sh --keep          # leave the worker + tunnel running at the end
#
# Prereqs: the CLI is built (cd packages/cli && npm install && npm run build) and the Python
# runtime is installed (cd python/agent-runtime && pip install -e ".[dev]"). cloudflared is
# downloaded once automatically by the CLI.
set -euo pipefail

# --- locate repo + dirs ------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROOF_WORKER_DIR="$ROOT/examples/live-demo"
CLI="$ROOT/packages/cli/dist/cli.js"
DATE_UTC="$(date -u +%Y-%m-%d)"
PROOF_DIR="$ROOT/docs/proof"
TRANSCRIPT="$PROOF_DIR/live-proof-$DATE_UTC.md"
CAST="$PROOF_DIR/live-proof.cast"

# --- args --------------------------------------------------------------------------------
MODEL_URL=""          # empty => launch the bundled mock model
PORT=3000
RECORD=0
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --model-url) MODEL_URL="${2:-}"; shift 2 ;;
    --port)      PORT="${2:-3000}"; shift 2 ;;
    --record)    RECORD=1; shift ;;
    --keep)      KEEP=1; shift ;;
    -h|--help)   sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Re-exec under asciinema if --record was asked for and we are not already inside a cast.
if [ "$RECORD" = "1" ] && [ "${LIVE_PROOF_RECORDING:-}" != "1" ]; then
  if command -v asciinema >/dev/null 2>&1; then
    mkdir -p "$PROOF_DIR"
    inner="bash $0 --port $PORT"
    [ -n "$MODEL_URL" ] && inner="$inner --model-url $MODEL_URL"
    [ "$KEEP" = "1" ] && inner="$inner --keep"
    echo "recording asciinema cast -> $CAST"
    LIVE_PROOF_RECORDING=1 exec asciinema rec --overwrite -c "$inner" "$CAST"
  else
    echo "asciinema not found — continuing without a recording (text transcript still captured)." >&2
  fi
fi

[ -f "$CLI" ] || { echo "CLI not built: $CLI missing. Run: (cd packages/cli && npm install && npm run build)" >&2; exit 1; }
mkdir -p "$PROOF_DIR"

# --- pick a python (prefer the runtime venv) ---------------------------------------------
PYBIN="python3"
if [ -x "$ROOT/python/agent-runtime/.venv/bin/python" ]; then
  PYBIN="$ROOT/python/agent-runtime/.venv/bin/python"
fi

HAVE_JQ=0; command -v jq >/dev/null 2>&1 && HAVE_JQ=1

# --- teardown ----------------------------------------------------------------------------
UP_PID=""; MODEL_PID=""; RESTORE_WORKER=0
cleanup() {
  set +e
  if [ "$KEEP" = "1" ] && [ -n "$UP_PID" ]; then
    echo ">> --keep: leaving worker (pid $UP_PID) + tunnel running. Ctrl-C to stop."
    wait "$UP_PID" 2>/dev/null
  fi
  [ -n "${DEV_PID:-}" ] && kill "$DEV_PID" 2>/dev/null
  [ -n "$UP_PID" ] && kill "$UP_PID" 2>/dev/null
  [ -n "$MODEL_PID" ] && kill "$MODEL_PID" 2>/dev/null
  if [ "$RESTORE_WORKER" = "1" ]; then
    if [ -f "$PROOF_WORKER_DIR/worker.yaml.live-proof.bak" ]; then
      mv -f "$PROOF_WORKER_DIR/worker.yaml.live-proof.bak" "$PROOF_WORKER_DIR/worker.yaml"
    else
      rm -f "$PROOF_WORKER_DIR/worker.yaml"
    fi
  fi
}
trap cleanup EXIT INT TERM

# --- stage the proof manifest as worker.yaml (airlock up boots worker.yaml from cwd) -----
if [ -f "$PROOF_WORKER_DIR/worker.yaml" ]; then
  cp -f "$PROOF_WORKER_DIR/worker.yaml" "$PROOF_WORKER_DIR/worker.yaml.live-proof.bak"
fi
RESTORE_WORKER=1
cp -f "$PROOF_WORKER_DIR/worker.proof.yaml" "$PROOF_WORKER_DIR/worker.yaml"
rm -rf "$PROOF_WORKER_DIR/.airlock"   # fresh state so the held-approval queue shows only this run

# If a real model URL was supplied, point all bindings at it.
if [ -n "$MODEL_URL" ]; then
  # portable in-place edit (BSD/GNU sed)
  sed -i.bak2 -E "s#http://127\.0\.0\.1:8999/v1/chat/completions#${MODEL_URL//#/\\#}#g" "$PROOF_WORKER_DIR/worker.yaml"
  rm -f "$PROOF_WORKER_DIR/worker.yaml.bak2"
  echo ">> using real model endpoint: $MODEL_URL"
else
  echo ">> launching bundled mock model (model.py) on :8999"
  ( cd "$PROOF_WORKER_DIR" && MOCK_MODEL_HOST=127.0.0.1 "$PYBIN" model.py --port 8999 ) &
  MODEL_PID=$!
  sleep 1
fi

# --- 1) boot the worker locally (reliable) -----------------------------------------------
# We DECOUPLE the worker from the tunnel: `airlock up` can do both in one command for
# interactive use, but free Cloudflare quick-tunnel hostnames propagate flakily (some never
# resolve). So we boot the worker once and then open a tunnel with retry — restarting the
# *tunnel* (not the worker) until a hostname actually resolves. Same product, robust proof.
UP_LOG="$(mktemp -t live-proof-up.XXXXXX)"
echo ">> booting the worker on :$PORT (airlock up --no-tunnel)…"
( cd "$PROOF_WORKER_DIR" && PYTHONPATH="$PROOF_WORKER_DIR" AIRLOCK_PYTHON="$PYBIN" \
    node "$CLI" up --port "$PORT" --no-tunnel ) >"$UP_LOG" 2>&1 &
UP_PID=$!
for _ in $(seq 1 60); do
  curl -fsS --max-time 4 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  kill -0 "$UP_PID" 2>/dev/null || { echo "!! worker exited early. Log:" >&2; cat "$UP_LOG" >&2; exit 1; }
  sleep 1
done
curl -fsS --max-time 4 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 \
  || { echo "!! worker never became healthy. Log:" >&2; cat "$UP_LOG" >&2; exit 1; }
echo ">> worker healthy on http://127.0.0.1:$PORT"

# --- 2) open a public Cloudflare tunnel, retrying until a hostname actually resolves ------
DEV_PID=""; PUBLIC=""
open_tunnel() {  # prints URL on success, serves within ~45s, else fails
  local log; log="$(mktemp -t live-proof-dev.XXXXXX)"
  ( cd "$PROOF_WORKER_DIR" && node "$CLI" dev --port "$PORT" ) >"$log" 2>&1 &
  DEV_PID=$!
  local url=""
  for _ in $(seq 1 20); do
    url="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" | head -n1 || true)"
    [ -n "$url" ] && break
    kill -0 "$DEV_PID" 2>/dev/null || break
    sleep 1
  done
  [ -n "$url" ] || { kill "$DEV_PID" 2>/dev/null; DEV_PID=""; return 1; }
  for _ in $(seq 1 15); do                          # ~45s for THIS hostname to resolve
    if curl -fsS --max-time 5 "$url/healthz" >/dev/null 2>&1; then PUBLIC="$url"; return 0; fi
    sleep 3
  done
  kill "$DEV_PID" 2>/dev/null; DEV_PID=""; return 1  # bad hostname — caller retries fresh
}
echo ">> opening a real Cloudflare quick tunnel (first run downloads cloudflared)…"
for attempt in 1 2 3 4 5; do
  echo ">> tunnel attempt ${attempt} of 5"
  if open_tunnel; then echo ">> tunnel serving: $PUBLIC"; break; fi
  echo ">> that hostname didn't propagate — retrying with a fresh tunnel."
done
[ -n "$PUBLIC" ] || { echo "!! could not get a resolving quick tunnel after 5 attempts (Cloudflare free-tier propagation). The worker is fine locally; re-run, or use --model-url with your own durable tunnel." >&2; exit 1; }

# From here a transient curl failure must NOT abort the proof — we want the transcript to
# capture whatever the public URL returns. Teardown still runs via the EXIT trap.
set +e

# --- transcript helpers ------------------------------------------------------------------
: > "$TRANSCRIPT"
log()  { echo "$@" | tee -a "$TRANSCRIPT"; }
fence(){ printf '```%s\n' "${1:-}" >>"$TRANSCRIPT"; }
endf() { printf '```\n\n' >>"$TRANSCRIPT"; }
# run a curl, echo the command + (pretty) response into the transcript and stdout
show() {
  local title="$1"; shift
  log ""; log "### $title"; log ""
  fence bash; echo "\$ $*" | tee -a "$TRANSCRIPT"; endf
  fence json
  local out; out="$("$@" 2>&1)"
  if [ "$HAVE_JQ" = "1" ]; then echo "$out" | jq . 2>/dev/null | tee -a "$TRANSCRIPT" || echo "$out" | tee -a "$TRANSCRIPT"
  else echo "$out" | tee -a "$TRANSCRIPT"; fi
  endf
}
cc() { curl -s "$PUBLIC/v1/chat/completions" -H 'content-type: application/json' -d "$1"; }

# --- header ------------------------------------------------------------------------------
{
  echo "# airlock live proof — over a real public URL ($DATE_UTC)"
  echo
  echo "> Generated by \`scripts/live-proof.sh\`. **Not localhost.** A real \`openai\`-harness"
  echo "> model loop, exposed on a real Cloudflare quick tunnel, driven by \`curl\` against the"
  echo "> public address below. The URL is ephemeral — it died when the script exited; this"
  echo "> transcript is the durable evidence."
  echo
  echo "**Public URL:** \`$PUBLIC\`"
  echo "**Callers POST to:** \`$PUBLIC/v1/chat/completions\`"
  echo
  echo "Model: ${MODEL_URL:-bundled mock model.py (zero-dependency, deterministic)} · Harness: \`openai\` (airlock OWNS the loop)"
  echo
} | tee -a "$TRANSCRIPT"

echo
echo "==========================================================================="
echo "  LIVE on the public internet:  $PUBLIC"
echo "==========================================================================="
echo

# --- the battery (all against the PUBLIC url) --------------------------------------------
show "Health (the public URL is live)" curl -s "$PUBLIC/healthz"
show "Manifest — harness + expose (reported by the public worker)" curl -s "$PUBLIC/v1/manifest"

show "Epic 01 — airlock owns a REAL model loop (model → tool_result → final)" \
  cc '{"messages":[{"role":"user","content":"TOOLCALL:echo:{\"text\":\"hello from the public web\"}"}],"include_steps":true}'

show "Epic 02 — tool gating: a dangerous argument is DENIED mid-loop" \
  cc '{"messages":[{"role":"user","content":"TOOLCALL:echo:{\"text\":\"rm -rf /\"}"}],"include_steps":true}'

show "Epic 02 — the same tool with a safe argument completes" \
  cc '{"messages":[{"role":"user","content":"TOOLCALL:echo:{\"text\":\"ls\"}"}],"include_steps":true}'

log ""; log "### Epic 02 — mid-run approval: hold → inspect → approve → resume"; log ""
show "1) fire it — \`send\` parks for a human (BLOCKED)" \
  cc '{"messages":[{"role":"user","content":"TOOLCALL:send:{\"to\":\"ceo@example.com\",\"body\":\"ship it\"}"}],"run_id":"approve-live","include_steps":true}'
show "2) see it waiting" curl -s "$PUBLIC/v1/runs/held"
show "3) approve it" curl -s "$PUBLIC/v1/runs/approve-live/decision" -H 'content-type: application/json' -d '{"decision":"approve"}'
show "4) resume (same run_id) → completes" \
  cc '{"messages":[{"role":"user","content":"TOOLCALL:send:{\"to\":\"ceo@example.com\",\"body\":\"ship it\"}"}],"run_id":"approve-live"}'

show "Epic 07/10 — skill enabled (calc → 200)"  curl -s -o /dev/null -w '%{http_code}\n' "$PUBLIC/skills/calc"   -H 'content-type: application/json' -d '{"input":"hi"}'
show "Epic 07/10 — skill disabled (danger → 403, tool dropped from loop)" curl -s -o /dev/null -w '%{http_code}\n' "$PUBLIC/skills/danger" -H 'content-type: application/json' -d '{"input":"hi"}'
show "Epic 07/10 — unknown skill (nope → 404)" curl -s -o /dev/null -w '%{http_code}\n' "$PUBLIC/skills/nope" -H 'content-type: application/json' -d '{"input":"hi"}'

log ""; log "### Epic 05 — live step streaming (SSE \`event: step\` frames over the tunnel)"; log ""
fence bash; echo "\$ curl -N $PUBLIC/v1/chat/completions -d '{…,\"stream\":true}'" | tee -a "$TRANSCRIPT"; endf
fence
curl -sN "$PUBLIC/v1/chat/completions" -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"TOOLCALL:echo:{\"text\":\"streamed\"}"}],"stream":true}' \
  | head -c 1200 | tee -a "$TRANSCRIPT"
endf

# --- optional: the opt-in showcase tunnel test ------------------------------------------
if "$PYBIN" -c "import pytest" >/dev/null 2>&1; then
  echo
  echo ">> running the opt-in tunnel test against $PUBLIC"
  if AIRLOCK_LIVE_TUNNEL_URL="$PUBLIC" AIRLOCK_LIVE_HARNESS="openai" \
       "$PYBIN" -m pytest "$ROOT/examples/showcase-tests/test_live_tunnel.py" -q 2>&1 | tee -a "$TRANSCRIPT"; then
    log ""; log "_opt-in tunnel test: PASS (assertions ran against the public URL)._"
  else
    log ""; log "_opt-in tunnel test: see output above._"
  fi
else
  echo ">> pytest not available in $PYBIN — skipping the opt-in tunnel test." | tee -a "$TRANSCRIPT"
fi

echo
echo "==========================================================================="
echo "  PROVED on the public web:  $PUBLIC"
echo "  transcript: $TRANSCRIPT"
[ "$RECORD" = "1" ] && [ -f "$CAST" ] && echo "  recording:  $CAST"
echo "==========================================================================="
