# Scale on Cloudflare with named-tunnel connector replicas

A deployed Agent must serve many Callers at low latency under one **stable**
hostname. The scale ceiling today is self-imposed, not Cloudflare's: a fixed
concurrency cap of 4 (clamped to 1 for an in-process model), a blocking
threadpool request path, no streaming, and a single untuned, unsupervised
connector. We resolve this **without** hosting inference
([ADR-0008](./0008-airlock-never-hosts-inference.md)) and **without** uvicorn
workers — horizontal scale stays *more boxes*, not *more processes per box*
([ADR-0010](./0010-per-call-agent-isolation.md)).

The chosen architecture has two phases. **Per box**, we stop throttling
ourselves. `AIRLOCK_MAX_CONCURRENCY` is redocumented as *the model's real
parallel capacity* (a remote provider's concurrency, or `llama-server --parallel
N`) rather than an arbitrary wrapper limit. The run-gate now does **latency-aware
admission**: it tracks an EWMA of observed run time and sheds a caller only when
the *estimated* wait (EWMA × queue depth) exceeds a budget (`AIRLOCK_MAX_WAIT_S`),
returning `429` + `Retry-After` immediately instead of blocking on a blind 30s
countdown and then dropping it. The chat surface **streams** (SSE): an immediate
first frame + heartbeat (Tier A, every harness) so time-to-first-byte is ~0, and
real incremental deltas where a harness exposes them (Tier B, via an optional
`run_stream`). We explicitly **did not** add an async adapter path — five of six
harnesses call the model synchronously inside the framework loop, so the
threadpool is correct and the model, not the wrapper, is the concurrency unit (a
live test showed four "parallel" runs taking ~5× longer than one).

**Across boxes**, we scale the way Cloudflare already supports: run **multiple
cloudflared connector replicas on one named-tunnel token**, and Cloudflare
load-balances across all healthy connectors under a single hostname. Because the
surface is stateless per call, any replica serves any request — no session
affinity. The connector is tuned (`--protocol quic`, optional `--region`,
`--metrics`) and **supervised** (reconnect with backoff on unexpected exit)
instead of treated as fatal.

This is the ngrok lesson translated, not reinvented: ngrok backs one endpoint
with multiple pooled, auto-reconnecting, load-balanced backends; Cloudflare named
tunnels + replicas (+ optional Load Balancing) give the same shape natively. The
quick tunnel ([ADR-0001](./0001-we-operate-the-hosted-dev-tunnel.md)) stays a dev
surface only — it's rate-limited and ephemeral; the scale path lives on the
durable named tunnel. The full review and design is in
[`docs/scaling-cloudflare.md`](../scaling-cloudflare.md).

## Considered Options

- **Raise the concurrency cap and call it done** — helps the I/O-bound
  remote-provider case, but a single box still has one event loop and one local
  model can't do concurrent inference. Rejected as the *whole* answer: it ignores
  the multi-box requirement and the local-model reality. Kept as Phase 1.
- **uvicorn workers / multiple processes per box** — multiplies N per process and
  breaks the per-process cap and build-once assumptions (ADR-0010). Rejected: the
  out-of-process model server, not extra Python processes, is where real
  concurrency belongs.
- **Cloudflare Load Balancer as the primary mechanism** — health-checked pools
  and regional steering are useful, but for one tunnel the connector-replica
  fan-out already load-balances with zero extra Cloudflare product. Kept as an
  optional add-on for health checks and failover, not the foundation.
- **Build our own tunnel/load-balancer fleet (ngrok-style)** — reinvents
  infrastructure Cloudflare already provides and would mean holding production
  traffic, violating ADR-0001's "never hold *production* traffic" line. Rejected.
- **Stream without raising the cap** — streaming cuts perceived latency but the
  run still holds its slot for the full duration, so a cap of 4 still throttles
  throughput. Rejected as a standalone fix; streaming and the admission change
  ship together.
- **Async adapter path (coroutines instead of the threadpool)** — was in the
  draft plan. Rejected once exploration + a live test showed five of six harnesses
  (smolagents, langgraph, crewai, openai-agents, custom) call the model
  *synchronously inside the framework loop*; the threadpool is the right tool and
  the binding limit is the model's batching, not Python threads. Rewriting each
  framework's loop to be async would also violate ADR-0007 ("the loop is the
  contract"). Only the Claude SDK harness is natively async, and it already works.
- **Blind per-caller queue timeout (the old 30s)** — a live test showed runs
  under load taking ~68s while the 30s timeout shed waiting callers *before* any
  slot could free, collapsing good-put. Replaced with estimate-vs-budget admission
  so callers who'd wait a reasonable time queue, and hopeless ones fail fast with
  `Retry-After`.
