#!/usr/bin/env bash
#
# try-fresh.sh — rehearse the brand-new-developer airlock flow in a throwaway,
# self-contained environment. Each run creates a fresh timestamped sandbox (new
# venv + scratch project copy) under $TRY_BASE, so you can reinstall fresh every
# time without deleting anything.
#
#   scripts/try-fresh.sh [HARNESS_REPO] [PROJECT_NAME]
#
#   HARNESS_REPO   path to the agent repo to deploy (default: ~/Documents/smol-harness)
#   PROJECT_NAME   airlock project name           (default: basename of the repo)
#   PORT (env)     port to serve on               (default: 3000)
#   TRY_BASE (env) where sandboxes live           (default: /tmp/airlock-try)
#
# NOTE: airlock-agent / airlock-payment are not on PyPI yet, so we install them
# editable from THIS repo. The harness is installed editable from its own repo
# (so its imports + any local model resolve there); a light source copy is what
# `airlock init --detect` scans and wires.

set -euo pipefail

AIRLOCK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARNESS_REPO="${1:-$HOME/Documents/smol-harness}"
PROJECT_NAME="${2:-$(basename "$HARNESS_REPO")}"
PORT="${PORT:-3000}"
TRY_BASE="${TRY_BASE:-/tmp/airlock-try}"
TRY="$TRY_BASE-$(date +%Y%m%d-%H%M%S)"

CLI="$AIRLOCK/packages/cli/dist/cli.js"
[ -f "$CLI" ] || { echo "error: CLI not built — run \`pnpm --filter @airlockhq/cli build\` first" >&2; exit 1; }
[ -d "$HARNESS_REPO" ] || { echo "error: harness repo not found: $HARNESS_REPO" >&2; exit 1; }

echo "▸ sandbox:  $TRY"
echo "▸ harness:  $HARNESS_REPO  (project: $PROJECT_NAME)"
mkdir -p "$TRY"

# 1) Fresh, isolated venv. Prefer a modern Python (smolagents/etc. need >=3.10).
PY="${PYTHON:-}"
if [ -z "$PY" ]; then
  for c in python3.12 python3.11 python3.10 python3; do
    command -v "$c" >/dev/null 2>&1 && { PY="$c"; break; }
  done
fi
echo "▸ creating fresh venv ($("$PY" --version 2>&1))…"
"$PY" -m venv "$TRY/venv"
V="$TRY/venv/bin"
"$V/python" -m pip install -q --upgrade pip

# 2) airlock runtime (local, unpublished) + web deps.
echo "▸ installing airlock runtime + web deps…"
"$V/pip" install -q -e "$AIRLOCK/python/payment-fly" -e "$AIRLOCK/python/agent-runtime" \
  "fastapi>=0.115,<1" "uvicorn[standard]>=0.30,<1" "pyyaml>=6,<7"

# 3) The harness itself (editable, from its own repo — brings its deps + model).
echo "▸ installing harness (editable) — this may compile native deps the first time…"
"$V/pip" install -q -e "$HARNESS_REPO"

# 4) Light source copy → the fresh airlock-wired project (no venv/git/model/caches).
echo "▸ copying harness source to the sandbox project…"
mkdir -p "$TRY/app"
rsync -a --exclude '.venv' --exclude '.git' --exclude '__pycache__' \
  --exclude 'models' --exclude 'node_modules' "$HARNESS_REPO"/ "$TRY/app"/

# 5) Detect + wire the [agent] config.
echo "▸ airlock init --detect…"
( cd "$TRY/app" && node "$CLI" init "$PROJECT_NAME" --target=fly --detect )

# 6) Serve it (config-driven; loads the harness once).
echo "▸ starting: python -m airlock_agent on :$PORT"
echo "  test it:  curl localhost:$PORT/v1/chat/completions -H 'content-type: application/json' -d '{\"messages\":[{\"role\":\"user\",\"content\":\"what is 23 times 19?\"}]}'"
cd "$TRY/app"
PORT="$PORT" exec "$V/python" -m airlock_agent
