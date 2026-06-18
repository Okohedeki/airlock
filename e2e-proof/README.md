# airlock — live end-to-end proof

A from-scratch, **no-localhost** end-to-end test of the README's claims. The worker
runs **in Docker**, exposed on a **live Cloudflare quick tunnel**; every call below
hit the public `https://<rand>.trycloudflare.com` URL. Run on **2026-06-18**.

> The public URL is ephemeral (it died when the tunnel stopped). These logs are the
> durable evidence. See [How to reproduce](#how-to-reproduce) to run it again.

## Topology (all Docker)

```
caller ──HTTPS──> Cloudflare quick tunnel ──> :3010 host ──> [e2e-worker container]
                                                                  airlock-worker:local
                                                                  openai harness, OWNS the loop
                                                                  AIRLOCK_MAX_CONCURRENCY=2, MAX_QUEUE=3
                                                                       │ model calls
                                                                       ▼
                                                            [e2e-mock-model container]
                                                            deterministic OpenAI-compatible model
                                                            (echoes binding; TOOLCALL: drives tools)
```

- Worker image: `airlock-worker:local` (the Compose/`docker build` image), manifest `worker/worker.yaml` (schema-valid).
- Two containers on a user-defined docker network; model reachable as `mock-model:8999`.
- Exposed with `cloudflared tunnel --url http://localhost:3010` — a real Cloudflare URL, no account/keys.

## Results — every README claim, proven over the public URL

Evidence: [`logs/battery.md`](./logs/battery.md) (feature battery) · [`logs/concurrency.md`](./logs/concurrency.md) (concurrency).

| # | README claim | Result | Evidence |
|---|---|---|---|
| 0 | OpenAI-compatible API, `/healthz` `/metrics` `/console` `/v1/manifest` live | ✅ | battery §0 |
| 1 | airlock **owns the loop** (model → tool → final, per-step `cost_usd`) | ✅ steps array | battery §1 |
| 2 | **Mid-run routing** — which binding answered | ✅ `[m-primary]` | battery §2 |
| 3 | **Mid-run fallback** — primary dead → retry → backup | ✅ `[m-backup]` | battery §3 |
| 4 | **Per-step tool gating** from real args | ✅ `TOOL_DENIED:echo` | battery §4 |
| 5 | **Mid-run approval** — hold → `/v1/runs/held` → decision → resume | ✅ `AWAIT_APPROVAL` → resumed | battery §5 |
| 6 | **Skills on/off** | ✅ 200 / 403 / 404 | battery §6 |
| 7 | **Loop guard — token budget** | ✅ `BUDGET_TOKENS` | battery §7 |
| 8 | **Loop guard — max steps** | ✅ `MAX_STEPS` | battery §8 |
| 9 | **Sandboxed execution** (wall-clock) | ✅ `tool exceeded wall_s=1s` | battery §9 |
| 10 | **Output contract** — redaction | ✅ `[REDACTED:email]` | battery §10 |
| 11 | **Controlled input** — injection rejected pre-loop | ✅ `prompt-injection pattern matched` | battery §11 |
| 12 | **Tool-result reuse** (cache) | ✅ 63ms → 0.78ms on repeat | battery §12 |
| 13 | **Multi-tenant** — per-tenant run isolation | ✅ acme sees only acme; globex only globex | battery §13 |
| 14 | **Triggers** — HMAC-signed webhook | ✅ valid → run; bad sig → 401 | battery §14 |
| 15 | **Live step streaming (SSE)** | ✅ `event: step` frames | battery §15 |
| 16 | **Run explorer** (`/v1/runs`) | ✅ list w/ stop_reasons | battery §16 |
| C | **Concurrency: marking, queueing, 429 backpressure** | ✅ see below | concurrency.md |

### Concurrency (cap=2, queue=3, model delay=2s, 8 simultaneous calls)

- Mid-burst `/metrics`: **running=2, waiting=3, pending=5** — running vs queued are marked live.
- **served(200)=5, shed(429)=3.** The 5 admitted returned in a staircase (~2.2s → ~4.3s → ~6.3s = batches of 2); the 3 over-queue requests got **429 immediately** (~0.2s).
- Wall time **6.4s vs ~16s serial** → genuine parallelism + bounded queue + backpressure.
- Each admitted request kept a **distinct `run_id`** (`conc-1,2,4,5,8`); the shed 429s never created a run.

## Notes / honest detail

- `cost_usd` is `0.0` because the mock model declares no `pricing:` block — the field is computed and present; add a price table to see non-zero $.
- The budget-stopped run still emitted its last message, but is **marked `stopped` / `BUDGET_TOKENS`** in `/v1/runs` and the step `stop_reason` — the guard fired.
- The model runs as a sibling container purely for a zero-dependency, deterministic proof; architecturally it's "your endpoint" (airlock never hosts inference).

## How to reproduce

```bash
# 1. build/confirm the worker image (Compose or docker build)
docker compose build worker        # produces airlock-worker:local

# 2. bring up worker + mock model on a docker network
docker network create airlock-e2e
docker run -d --name e2e-mock-model --network airlock-e2e --network-alias mock-model \
  -w /app/worker -v "$PWD/e2e-proof/worker:/app/worker" --entrypoint python \
  airlock-worker:local model.py --port 8999
docker run -d --name e2e-worker --network airlock-e2e -p 3010:3000 \
  -e HOOK_SECRET=topsecret -e AIRLOCK_MAX_CONCURRENCY=2 -e AIRLOCK_MAX_QUEUE=3 \
  -v "$PWD/e2e-proof/worker:/app/worker" airlock-worker:local

# 3. open a live Cloudflare tunnel, save the URL
cloudflared tunnel --url http://localhost:3010 > e2e-proof/logs/cloudflared.log 2>&1 &
grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' e2e-proof/logs/cloudflared.log | head -1 > e2e-proof/PUBLIC_URL.txt

# 4. run the proofs against the public URL
bash e2e-proof/run-battery.sh
docker rm -f e2e-mock-model && docker run -d --name e2e-mock-model --network airlock-e2e \
  --network-alias mock-model -w /app/worker -e MOCK_DELAY=2 \
  -v "$PWD/e2e-proof/worker:/app/worker" --entrypoint python airlock-worker:local model.py --port 8999
bash e2e-proof/run-concurrency.sh
```
