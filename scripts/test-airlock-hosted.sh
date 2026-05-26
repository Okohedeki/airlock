#!/usr/bin/env bash
#
# test-airlock-hosted.sh — end-to-end test of the AIRLOCK-HOSTED (serverless)
# MECHANISM on real Fly, WITHOUT the (not-yet-built) backend endpoint.
#
# It does exactly what the airlock backend will do once #5 ships:
#   1. create an app under your Fly org          (backend uses its org token)
#   2. mint a short-lived, app-scoped DEPLOY token (handed to the user's CLI)
#   3. build + deploy the vendored image via Fly's REMOTE builder with ONLY
#      that deploy token (no local Docker)
#   4. curl the public <app>.fly.dev URL off-box and assert a completion
#   5. destroy the app
#
# This proves the load-bearing claim the whole prong rests on — that an
# app-scoped deploy token can drive the remote builder. Uses a trivial echo
# agent so NO model/key is needed (mechanism test, not a model test).
#
#   scripts/test-airlock-hosted.sh [APP_NAME] [FLY_ORG]
#
# Prereqs: `fly` installed + `fly auth login` done (you = the airlock operator).

set -euo pipefail

AIRLOCK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${1:-airlock-hosted-test-$(date +%s)}"
ORG="${2:-personal}"
CLI="$AIRLOCK/packages/cli/dist/cli.js"
WORK="/tmp/airlock-hosted-$(date +%Y%m%d-%H%M%S)"

command -v fly >/dev/null 2>&1 || { echo "error: flyctl not installed — \`brew install flyctl\`" >&2; exit 1; }
fly auth whoami >/dev/null 2>&1 || { echo "error: not logged in — run \`fly auth login\`" >&2; exit 1; }
[ -f "$CLI" ] || { echo "error: CLI not built — \`pnpm --filter @airlockhq/cli build\`" >&2; exit 1; }

# portable in-place sed (BSD/macOS vs GNU)
sedi() { if sed --version >/dev/null 2>&1; then sed -i "$@"; else sed -i '' "$@"; fi; }

cleanup() { echo "▸ destroying app $APP…"; fly apps destroy "$APP" -y >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "▸ work dir: $WORK"
echo "▸ app: $APP   org: $ORG"
mkdir -p "$WORK"; cd "$WORK"

# 1) trivial echo agent + airlock detect context (vendored Dockerfile, no model)
cat > echo_agent.py <<'EOF'
def run(messages):
    last = messages[-1]["content"] if messages else ""
    return f"echo: {last}"
EOF
node "$CLI" init "$APP" --target=fly --detect >/dev/null
# detect leaves CHANGE_ME for a no-framework repo — point it at the echo agent
sedi 's/CHANGE_ME:your_agent/echo_agent:run/' .airlock/config.toml
sedi "s/^app = .*/app = \"$APP\"/" fly.toml

# 2) create the app under the org (the backend's org token will do this)
echo "▸ creating app under org…"
fly apps create "$APP" -o "$ORG"

# 3) mint an app-scoped DEPLOY token (this is the token the CLI gets, not the org token)
echo "▸ minting app-scoped deploy token…"
DEPLOY_TOKEN="$(fly tokens create deploy -a "$APP" -x 1h 2>/dev/null | grep -o 'FlyV1[^"]*' | head -1)"
[ -n "$DEPLOY_TOKEN" ] || { echo "FAIL: could not parse deploy token (check flyctl output format)"; exit 1; }

# 4) deploy with ONLY the deploy token, via the remote builder (no local Docker)
echo "▸ deploying via remote builder with the deploy token…"
FLY_API_TOKEN="$DEPLOY_TOKEN" fly deploy --app "$APP" --remote-only

# 5) off-box round-trip
URL="https://$APP.fly.dev"
echo "▸ calling $URL (allow for cold start)…"
RESP=""
for _ in $(seq 1 24); do
  RESP="$(curl -s --max-time 20 "$URL/v1/chat/completions" -H 'content-type: application/json' \
    -d '{"messages":[{"role":"user","content":"hello hosted"}]}' || true)"
  echo "$RESP" | grep -q '"object":"chat.completion"' && { echo "  $RESP"; echo "✓ AIRLOCK-HOSTED MECHANISM PASSED ($URL)"; exit 0; }
  sleep 5
done
echo "FAIL: $URL did not return a completion"
echo "  last response: $RESP"
exit 1
