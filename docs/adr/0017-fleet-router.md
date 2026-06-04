# Fleet router in front of the worker fleet

> **Status (2026-06-03): Accepted.** Redesign [epic 09](../redesign/plans/09-deploy-expose-and-fleet-router.md); used by epics 08/10/11/12. Supersedes the scaling model of [ADR-0011](./0011-scaling-on-cloudflare-named-tunnel-replicas.md) and the multi-Target model of [ADR-0003](./0003-two-targets-at-v1.md).

A single **Fleet Router** sits in front of the fleet of Workers and is the one place
cross-worker routing happens: version/variant/canary routing, agentic sharding,
load balancing, and sticky routing for resume/fork. **Control stays inside each
Worker** (the Loop Engine owns the loop); the router only decides *which* Worker
handles a request — it never reaches into a run.

This consolidates what used to be a matrix of per-Target Recipes
([ADR-0003](./0003-two-targets-at-v1.md)) and ad-hoc connector replicas
([ADR-0011](./0011-scaling-on-cloudflare-named-tunnel-replicas.md)) into one routing
layer over one Docker image ([ADR-0012](./0012-docker-first-runtime-model-external.md)).

## Considered Options

- **No router; expose each worker directly + external LB (rejected).** Pushes
  version/variant/canary/sticky logic onto the operator's own infrastructure and
  fragments the control story.
- **Put routing logic inside the workers (rejected).** Every worker would need to
  know about every other worker's version/variant/health — couples them and
  duplicates the routing brain N times.
- **One shared Fleet Router, control stays in-worker (accepted).** A single place
  for fleet decisions; workers stay focused on owning their own loop.

## Consequences

- Canary traffic split and instant rollback ([epic 08](../redesign/plans/08-versioning-canary-rollback.md))
  are router operations over content-addressed versions.
- Agentic sharding ([epic 12](../redesign/plans/12-agentic-sharding.md)) is the
  router selecting a Variant by capability → cost → live latency.
- Whether the router is a separate process or integrated with cloudflared is an open
  question in epic 09.

## Consequences — one ordered routing pipeline; stickiness wins over canary (2026-06-04)

The router's routing decision is frozen as a **single ordered pipeline**, not a set of
independent interceptors, so the four downstream epics plug into named stages instead
of bolting on competing hooks. v1 internal addressing is a **worker registry**
(`host:port` + registry, not mesh/DNS). Each stage is a pass-through until its epic
fills it in:

1. Authenticate + resolve **Tenant** (epic 10)
2. Select **Version** — stable vs canary (epic 08)
3. Select **Variant** — capability / cost / latency (epic 12)
4. **Sticky affinity** — pin session → replica (epic 04)
5. **Load-balance** across healthy replicas (epic 09 core)

The order resolves the dangerous interactions: tenant is resolved first (so version
pins and limits can be per-tenant), and **stickiness wins over canary** — a session's
canary bucket is decided *once* at session start and then pinned, so a live session
never flips version mid-run (conversational consistency over faster canary signal).
Triggers (epic 11) are just another request source entering at stage 2 — there is no
separate routing path for them. Boundary restated: the **router decides** which Worker
handles a request; the **Tunnel** only *exposes* a Worker to the public internet.
