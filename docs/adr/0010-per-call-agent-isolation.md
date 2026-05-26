# Per-call agent isolation, capped by a bounded queue

A deployed Agent must serve many Callers at once without their runs mixing. The
runtime builds a fresh agent **wrapper** per request (the harness's factory is
called again each call), while the **model** stays a single shared, out-of-process
resource (a model server or remote API). Concurrency is capped by
`AIRLOCK_MAX_CONCURRENCY`: up to N runs execute in parallel, callers beyond N queue
(FIFO), and callers beyond `AIRLOCK_MAX_QUEUE` (or who wait past
`AIRLOCK_QUEUE_TIMEOUT_S`) are shed with `429`. This keeps RAM at `O(N)` — one model
plus N cheap wrappers plus cheap suspended waiters — never one agent per Caller.

The wrapper is cheap (KBs) and the model is the heavy part, so the two must be
decoupled: the rule we document is **keep the model out-of-process; don't load
weights inside the factory.** A startup-timing guard catches violations — if the
first build is slow enough to look like in-process weight loading, per-call rebuild
is disabled (rebuilding would reload the weights every request) and the Agent falls
back to a single shared object governed by per-driver reentrancy.

Shedding load is safe because payment settles *after* the run
(`verify → run → settle`): a queued or rejected Caller is only verified, never
charged. Horizontal scale beyond one box's N is Fly machines behind the load
balancer, not uvicorn workers (which would multiply N per process and break the
per-process cap and build-once assumptions).

## Considered Options

- **Build once, share one agent object across all requests** — what the runtime did
  before. Cheapest, but concurrent requests mix state (smolagents memory/usage,
  crewai memory) and the only safe cap is 1. Rejected: defeats the goal of serving
  parallel Callers.
- **A fixed pool of N pre-built wrappers, checked out per request** — bounds RAM like
  per-call rebuild, but reintroduces "reset between uses" state-cleanup (the exact
  smolagents footgun) and adds lifecycle complexity. Rejected: per-call rebuild gives
  the same `O(N)` bound with simpler, GC'd isolation.
- **Load the model in-process and run N copies for parallelism** — N × model RAM, and
  a local llama context still can't do concurrent inference. Rejected: doesn't scale;
  the out-of-process model server is where concurrency belongs.
