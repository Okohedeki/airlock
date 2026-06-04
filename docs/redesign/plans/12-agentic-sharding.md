# Epic 12 — Agentic sharding

## Context
At scale an operator wants many worker variants behind one endpoint — routed by capability, cost,
or latency, and load-balanced across the fleet. Today scaling is N identical stateless replicas
under one Cloudflare tunnel with no variant concept. This epic adds variant routing on the fleet
router (epic 09).

## Scope
- **Agentic sharding:** many worker variants behind one endpoint, routed by capability / cost /
  latency, load-balanced.

## Dependencies
09 (fleet router). Complements 08 (versions are a special case of variants).

## Design (locked: variants in worker.yaml; capability → cost → latency)
- **`variants:` in `worker.yaml`** declares the variants (each a worker version/config, e.g.
  different model bindings or skill sets) behind one endpoint.
- The **fleet router (09)** selects a variant per request by **capability match** (the requested
  skill/tag the variant offers) → tie-break by **cost** → then **live latency** (EWMA from each
  replica's `/metrics`), and **load-balances** across healthy replicas of the chosen variant.
- Reuses the router's health/metrics signals already available (`/healthz`, `/metrics` EWMA from
  the existing concurrency module).

## Key files
Router variant-routing logic (epic 09 `router/`); `worker.yaml` `variants`/`sharding` schema;
capability index derived from each variant's skills.

## Open questions
- Cost signal source (static per-variant cost estimate from the price table vs measured).
- Routing-signal priority/weights and whether operators can override the order.
- How capability is matched (explicit tags vs skill ids from the descriptor).

## Verification
- Requests route to the correct variant by the declared capability policy; cost/latency tie-breaks
  apply.
- Load spreads across healthy replicas of the selected variant; an unhealthy replica is avoided.
