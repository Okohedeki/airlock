> ⚠️ **Historical — superseded by [`docs/redesign/`](./redesign/).** Scaling is now the Fleet Router + state store (redesign epics 04/09). Kept for reference.

# Scaling on Cloudflare — latency + concurrent requests

`airlock up` exposes a publisher's agent over a Cloudflare tunnel. This doc asks
the scale question directly: **how do we serve many concurrent agent requests,
with low latency, at multi-box scale under one stable hostname** — without
breaking the project's two hard rules:

- airlock **never hosts inference** ([ADR-0008](./adr/0008-airlock-never-hosts-inference.md)).
- horizontal scale is **more boxes, not uvicorn workers**
  ([ADR-0010](./adr/0010-per-call-agent-isolation.md)).

The short version: **the ceiling we hit today is mostly self-imposed, not
Cloudflare's.** A fixed concurrency cap of 4 (1 for a local model), a blocking
threadpool request path, no streaming, and a single untuned/unsupervised
connector account for almost all of it. The decision is recorded in
[ADR-0011](./adr/0011-scaling-on-cloudflare-named-tunnel-replicas.md); this doc
is the detailed review and the design behind it.

> **Where ngrok comes in.** The instinct to "learn from ngrok" is right, but the
> lesson is architectural, not about TLS. ngrok backs one stable endpoint with
> multiple pooled, auto-reconnecting agent connections and load-balances across
> registered backends. Cloudflare gives the same shape natively — a **named
> tunnel with multiple connector replicas + Load Balancing** — and we simply
> don't use it yet. See the mapping table below.

---

## 1. The review — where the limits actually are

References are `file:line` against the current tree.

### A. Concurrency ceiling (the dominant problem)

1. **Fixed cap of 4.** `python/agent-runtime/src/airlock_agent/concurrency.py:20`
   sets `DEFAULT_MAX_CONCURRENCY = 4`. For an agent that just orchestrates calls
   to a fast **remote** provider, the work is pure I/O — one event loop could
   keep hundreds of requests in flight. Capping at 4 throttles the common case.
2. **Local model serializes to 1.** `concurrency.py:94-98` clamps `effective` to
   **1** for a shared, non-reentrant instance, and `__main__.py:79-86` flips a
   factory entrypoint to "shared" whenever the first build takes > 1.5s (the
   in-process-weights heuristic). Net effect: a locally-loaded model serves **one
   request at a time** (`__main__.py:91-93`). This is *correct* for thread-safety,
   but it means the default local-model experience is single-threaded.
3. **Blocking threadpool, no async path.** `surface.py:101-102` runs the adapter
   as `await run_in_threadpool(adapter.run, …)`. Adapters are sync, so every
   in-flight request burns an OS thread (the anyio limiter is bumped to
   `max_concurrency+1` at `surface.py:69-71`). Even a pure-I/O remote-provider
   agent is bounded by threads instead of cheap coroutines — there is no async
   adapter path.
4. **One process, no fan-out wired up.** `__main__.py:109` is a single
   `uvicorn.run(build_app())` — one process, no workers (intentional, ADR-0010).
   A single box's ceiling is therefore one event loop + the gate, and **nothing
   today puts multiple boxes under one Cloudflare hostname.**

### B. Latency

5. **No streaming.** `surface.py:92-110` runs the full agent loop, then returns
   one buffered `JSONResponse`. Time-to-first-byte equals the full multi-step
   generation, and the run holds a concurrency slot the whole time. This is the
   worst case for agentic loops, where latency compounds across steps (ADR-0008).
   (The `serve.ts` forwarder *can* stream `stream:true`; the `up` runtime cannot.)
6. **Connector spawned with zero tuning.** `tunnel.ts:40` and `tunnel.ts:95` call
   `Tunnel.quick(...)` / `Tunnel.withToken(...)` with **no flags** — no
   `--protocol quic`, no `--region`, no edge-connection count, no `--metrics`.
   The connector can register to a distant Cloudflare datacenter, adding backbone
   RTT to *every* request; for agentic loops that per-hop overhead compounds.
7. **Serial payment round-trips.** Payment runs `verify → run → settle`
   (`packages/payment-fly-node/src/middleware.ts`,
   `python/payment-fly/src/airlock_payment/middleware.py`) — two facilitator
   round-trips on the critical path in flat mode. Per-token sessions amortize
   this after the first call; flat mode pays it every call.
8. **Usage is blinded.** `surface.py:38` hardcodes `prompt_tokens:0,
   completion_tokens:0` (only `total_tokens`). Minor, but it removes the signal
   you'd want when reasoning about cost vs. latency.

### C. Tunnel / scale / resilience

9. **No reconnect or supervision.** `tunnel.ts:56-59,111-117` reject the promise
   on `exit`. If cloudflared dies, the tunnel is gone with no restart — an
   availability gap under sustained load.
10. **Quick tunnel is the default.** `tunnel.ts:40`. Quick tunnels are
    rate-limited, best-effort, single ephemeral hostname — explicitly not for
    production (ADR-0001). Any scale story must live on the named/durable path.
11. **Named tunnel runs exactly one connector.** `startNamedTunnel`
    (`tunnel.ts:85-121`) resolves on the first `connected` and stops there. It
    does not use cloudflared's ability to run **multiple replicas of the same
    named tunnel**, which Cloudflare load-balances across automatically. This is
    the unused, ngrok-style fan-out.
12. **No tunnel metrics.** Without `cloudflared --metrics` there's no view of
    connector saturation, in-flight requests, or edge errors — "are we at
    capacity?" is unanswerable.

---

## 2. The design

Under the never-host-inference constraint, the terms mean:

- **"Fast inference"** = add no avoidable overhead in the request path, let the
  publisher point at a fast provider, and **stream** so *perceived* latency drops.
- **"Handle multiple requests"** = decouple the agent-wrapper concurrency from a
  fixed small number, and **fan out across boxes under one hostname.**

### The ngrok → Cloudflare mapping

| ngrok capability | Cloudflare-native equivalent |
|---|---|
| One stable endpoint, many backends | **Named tunnel + multiple connector replicas** — run the same connector token on N processes/boxes; Cloudflare load-balances across all healthy connectors |
| Health-checked steering / failover | **Cloudflare Load Balancing** (origin pools; `/healthz` already exists at `surface.py:88-90`) |
| Pooled, multiplexed agent connections | cloudflared **QUIC + HA connections** to ≥2 datacenters (tune via flags) |
| Auto-reconnect | cloudflared reconnects to the edge itself — our wrapper must **supervise** instead of treating `exit` as fatal |

The point: we don't need to build ngrok's machinery. Cloudflare already has it;
the named-tunnel path just needs to *use* it.

### Phase 1 — Stop self-throttling on a single box

- **Decouple the cap from a fixed 4.** `AIRLOCK_MAX_CONCURRENCY` now *means* the
  model's real parallel capacity: I/O-bound (remote provider) → high; CPU/GPU-bound
  (local model) → bounded by the model server's batching, not by us.
- **~~Add an async adapter path~~ — rejected after investigation.** Five of six
  harnesses call the model *synchronously inside the framework loop*, so the
  threadpool is correct and the model (not Python threads) is the limiter — a live
  test showed four "parallel" runs taking ~5× longer than one. Going async would
  mean rewriting each framework's loop (violates ADR-0007). Only the Claude SDK
  harness is natively async, and it already works.
- **Latency-aware admission** instead of a blind timeout: the gate tracks a
  run-time EWMA and sheds a caller only when the estimated wait exceeds
  `AIRLOCK_MAX_WAIT_S`, returning `429` + `Retry-After`; callers who'd wait a
  reasonable time queue instead.
- **Add SSE streaming** to `surface.py` so TTFB ≈ first frame. Tier A (heartbeat +
  final) for every harness; Tier B (real incremental deltas) via an optional
  `run_stream`. (Streaming improves *perceived* latency, not slot turnover — the
  run still holds its slot until done, so pair streaming with right-sized
  concurrency.)
- **Keep the clamp-to-1 for non-reentrant in-process instances** — it's correct.
  But document loudly: the way to scale a local model is to **run it as a server
  with batching** (vLLM, `llama-server --parallel`) and let airlock be I/O-bound
  against it. A single in-process model context can't do concurrent inference;
  no amount of airlock tuning changes that.
- **Tune + supervise the connector**: thread `--protocol quic`, optional
  `--region`, and `--metrics` through `tunnel.ts`; on an unexpected `exit`,
  restart with backoff instead of rejecting.

### Phase 2 — Multi-box under one hostname (the real scale answer)

- **N connector replicas on one named-tunnel token.** Each box runs its own
  `airlock up` (one uvicorn) plus a cloudflared connector sharing the token.
  Cloudflare load-balances across them; killing one box keeps the hostname up.
- **Optionally add Cloudflare Load Balancing** for explicit health checks,
  regional pools, and failover.
- **Statelessness makes this trivial.** The surface is stateless per call (the
  conversation resets each request — see README), so any replica can serve any
  request. No session affinity, no sticky routing. This is the property that
  makes horizontal fan-out free.
- **Capacity model.** Cluster concurrency ≈ Σ(per-box ceiling); per-box ceiling
  is set by the gate, cluster ceiling by replica count. Per-box `429` shedding
  (`surface.py:103-106`) stays the local backpressure signal, and Cloudflare LB
  routes away from saturated/unhealthy connectors.

### What we explicitly do not do

- No hosted inference (ADR-0008).
- No uvicorn workers — scale is boxes, not processes (ADR-0010), which keeps the
  per-process cap and build-once assumptions intact.
- airlock holds nothing beyond the connector on the durable path (ADR-0001).

---

## 3. Verifying this before writing code

Confirm the issues are real, then validate the fan-out cheaply before committing
to an implementation.

- **Reproduce the ceiling.** `airlock up` against a mock fast upstream; fire ~50
  concurrent requests (`oha` / `hey` / `k6`). Throughput pins at 4 (or 1 for an
  in-process / slow-build model) and the rest get `429` — confirms #1/#2/#3.
- **Confirm no streaming.** A `stream:true` request returns one buffered JSON
  body, not an SSE stream — confirms #5.
- **Confirm single connector / no restart.** Only one cloudflared process is
  running; kill it and watch the tunnel die with no recovery — confirms #9/#11.
- **Prototype the fan-out.** Run two local `airlock up` instances and point a
  cloudflared connector at each using the **same named-tunnel token**. Confirm
  Cloudflare spreads requests across both, and that killing one keeps the
  hostname serving. This validates Phase 2 before any code lands.
- **Benchmark targets to record here once measured.** P50/P95 added latency
  through the tunnel; sustained RPS per box; and cluster RPS scaling roughly
  linearly with replica count.

### Measured against a live `airlock up` (smolagents, payment off)

A first pass against a live quick tunnel confirmed the issues and surfaced one
the static review understated:

- **The cap is real and visible.** `GET /` reported `concurrency: {max:4, queue:50}`
  (#1), straight from `surface.py:83`.
- **No streaming, even when asked.** A `stream:true` request came back
  `content-type: application/json` with zero SSE frames and `ttfb == total`
  (~13s) — the flag is silently ignored (#5). A plain request showed the same
  `ttfb == total` (~16s): the client waits the entire agent loop.
- **Usage is blinded.** Responses carried `prompt_tokens:0, completion_tokens:0`
  with only `total_tokens` populated (#8) — and `total_tokens` was ~2,800 for
  "what is 2+2", a vivid measure of how much the loop does per call.
- **The model — not the cap — is the concurrency unit.** A solo request ran
  ~14s; **four at once ran ~68s each** (~4–5× slower). The out-of-process model
  can't actually do four concurrent inferences, so they contend. Implication:
  raising `AIRLOCK_MAX_CONCURRENCY` *without* a batching model server
  (vLLM / `llama-server --parallel`) trades throughput for per-request latency,
  not for good-put.
- **The queue timeout defeats the queue under real latency.** Firing 8 requests
  at a cap of 4 yielded **4×`200` at ~68s and 4×`429` at ~30s**: the over-cap
  callers hit `DEFAULT_QUEUE_TIMEOUT_S = 30s` (`concurrency.py:22`) and were shed
  *before* any slot freed (slots took ~68s). When run time under load exceeds the
  queue timeout, the 50-deep queue buffers nothing — good-put collapses to "4 per
  ~68s, reject the rest." The cap (#1) and the timeout default interact badly;
  the timeout should be derived from observed run latency, not a fixed 30s.

Not yet exercised end-to-end against real Cloudflare (need a named-tunnel token /
a second box): the multi-box connector-replica fan-out (#11).

---

## 4. What shipped (and how it was verified)

The single-box fixes and the tunnel/scale plumbing are implemented and tested.

**Concurrency / admission** (`concurrency.py`, `surface.py`)
- `BoundedGate` tracks a run-time EWMA and admits by *estimated wait* vs a budget
  (`AIRLOCK_MAX_WAIT_S`, default 120s; the old `AIRLOCK_QUEUE_TIMEOUT_S` is a
  deprecated alias). Over-budget callers get `429` + `Retry-After`.
- `AIRLOCK_MAX_CONCURRENCY` is redocumented as the model's parallel capacity.
- *Verified live* (uvicorn + concurrent curls): with a 2s budget and ~3s runs,
  over-budget callers were shed in <1ms with `Retry-After: 4`; with a 60s budget
  the same load queued and completed in a clean 3/6/9s staircase (no premature
  429s). `/metrics` mid-flight showed `running`/`waiting`/`est_wait_s`.

**Streaming** (`surface.py`, `payment-fly/.../middleware.py`)
- Tier A (heartbeat + final frame) for every harness; Tier B (real deltas) via an
  optional `run_stream` on the adapter — the per-harness wiring
  (smolagents/langgraph/claude) is the remaining follow-up (needs a live model to
  verify the step→delta mapping).
- Per-token billing for streams scans the SSE `usage` frame and debits after the
  stream (mirrors the Node forwarder); flat mode settles before the stream.
- *Verified live*: `stream:true` returned the role frame at ~0.01s, a heartbeat at
  ~12s, then content+usage — flushing incrementally **through** the
  `PaymentMiddleware`; Tier B deltas arrived spread across time; three streamed
  per-token calls drew a 0.10 balance down and the fourth correctly got `402`.

**Observability** (`surface.py`)
- Real `prompt_tokens`/`completion_tokens` in `usage`; a `/metrics` endpoint and
  live gate stats on `GET /`.

**Tunnel** (`packages/cli/src/tunnel.ts`, `up.ts`, `config-file.ts`, `cli.ts`)
- Connector tuning (`--protocol`/`--region`/`--metrics`, also `[tunnel]` keys /
  `--cf-*` flags) and **supervision**: a named tunnel reconnects with backoff on
  unexpected exit instead of dying.
- *Verified*: unit tests cover the flag mapping and the respawn/stop/fail-fast
  paths with a fake connector (all CLI + Python suites green).

**Multi-box** — already works with the shipped code: run `airlock up --durable`
on N boxes with the **same** `AIRLOCK_CF_TUNNEL_TOKEN`; Cloudflare load-balances
across the connectors. Health checks / regional steering remain the optional
Cloudflare Load Balancing tier. (Live multi-box validation needs a real token.)
