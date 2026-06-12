# Public-web proof — status

The product claim is **a controlled agent on the public web, not localhost**. Here is exactly
what is proven and how.

## Proven

- **The worker + full control surface works.** Booted the `openai`-harness proof worker
  (`examples/live-demo/worker.proof.yaml`) and drove a real model loop, tool gating, mid-run
  approval (hold → approve → resume), output redaction, skill ACLs (200/403/404) and SSE
  streaming. Every step behaved correctly. (Reproduce: `bash scripts/live-proof.sh`.)
- **The public exposure path works.** `airlock dev`/`airlock up` opens a real Cloudflare quick
  tunnel; a `https://<rand>.trycloudflare.com` URL served `/healthz` → `{"ok":true}` and
  `/v1/manifest` → `harness: openai, expose: public` **over the public internet** (captured
  during this session).
- **All six harnesses are green end-to-end** against a real local model — see
  [`showcase-grid-*.md`](./showcase-grid-2026-06-12.md) (41/41).

## Blocked tonight (external)

A *single clean full transcript* over one public URL was blocked by **Cloudflare free-tier
quick-tunnel propagation**: after ~10 tunnels in a short window, fresh `*.trycloudflare.com`
hostnames stopped resolving in DNS (`nodename nor servname provided`). This is a Cloudflare
rate-limit, not an airlock defect — the same script resolved a hostname in 0s earlier in the
session. `scripts/live-proof.sh` already retries up to 5 fresh tunnels.

## To capture the full transcript

- **Quick tunnel (zero-cred):** re-run `bash scripts/live-proof.sh` once the rate-limit resets
  (typically tens of minutes). It saves `docs/proof/live-proof-<date>.md`.
- **Durable tunnel (stable URL, recommended for a showcase):** `airlock up --durable` against a
  Cloudflare connector token gives a stable hostname that resolves instantly — no quick-tunnel
  rate limit. Point the proof at it with `scripts/live-proof.sh --model-url` + a durable boot.
