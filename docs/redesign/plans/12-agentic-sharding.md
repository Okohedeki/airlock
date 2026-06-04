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

---

# Build-ready spec (frozen contracts)

> Frozen 2026-06-04. Epic 12 **owns pipeline stage 3 `selectVariant`** in the frozen router (C4,
> [ADR-0017](../../adr/0017-fleet-router.md)). It does not build its own router. **Version (stage 2,
> epic 08) vs Variant (stage 3, here) are distinct:** stage 2 picks the *version line* (stable vs
> canary of the same logical worker); stage 3 picks the *capability variant* (which skill-bearing
> config serves this request). Per the glossary "a Version is a special case of a Variant" — they
> share machinery, but the pipeline keeps them as separate stages. Stage 5 (`loadBalance`, epic 09)
> spreads across healthy replicas **of the variant stage 3 selected** (registry key `name@version`
> is extended to `name@version#variant`).

## selectVariant — stage 3 (`router/stages/select-variant.ts`)
```ts
function selectVariant(
  ctx: RouteContext,                 // tenant (s1) + version (s2) already set
  cfg: VariantsConfig,               // from worker.yaml `variants`/`sharding` (C2)
  index: CapabilityIndex,            // built from each variant's descriptor skill ids
): string {                          // returns variant id; sets ctx.variant
  if (cfg.override) return cfg.override;                        // operator override (hard)
  const need = capabilityOf(ctx.request, cfg.routing.match);    // tag(s)/skill-id the request needs
  let cand = index.variantsFor(need, ctx.version);             // HARD FILTER: capability match
  if (cand.length === 0)
    cand = cfg.routing.fallbackVariant ? [cfg.routing.fallbackVariant] : index.all(ctx.version);
  cand.sort((a, b) =>                                          // tie-breaks, in frozen priority:
    estCost(a, cfg) - estCost(b, cfg)                          //   2. cost (static est, v1)
    || liveLatency(a) - liveLatency(b));                       //   3. live latency (EWMA, epic 09)
  return cand[0];
}
```
**Routing-signal priority (frozen):** capability match is a **hard filter** (not a weight) → among
matches, **cost** ascending → **live latency** (EWMA from `/metrics`, reused from epic 09's
concurrency module) as the final tie-break. An **operator `override`** short-circuits the whole
stage. No numeric weighting in v1 — strict lexicographic order keeps routing explainable.

## Capability matching (resolves open question)
**Explicit capability tags on each variant, validated against descriptor skill ids.** Each variant
declares `capabilities: [tag…]`; the build asserts every tag is backed by at least one `skills` id
present in that variant's descriptor (epic 13/00) — tags are the routable surface, skill ids are
the proof. A request's needed capability is derived from its target skill route (`/skills/<id>` →
the tag(s) that own that skill) or an explicit `X-Airlock-Capability` header. The
**capability index** is `tag → variant[]` per version line, built at deploy from the merged
descriptors and cached under `_system/capability-index/<name>` via the State Store (C3,
`scoped(tenant)`); rebuilt on `deploy`.

## `variants`/`sharding` block — `worker.schema.json` (C2, ONE schema, TS-validated)
```jsonc
"sharding": {
  "variants": [{
    "id": "fast-haiku",                 // unique; becomes registry suffix name@version#id
    "capabilities": ["summarize", "chat"],   // routable tags; must be backed by descriptor skills
    "skills": ["summarize", "chat"],         // descriptor skill ids that back the tags (epic 13/00)
    "costEstimate": 1,                  // static per-variant cost rank (v1; measured later)
    "config": { "$ref": "#/$defs/workerConfigOverlay" }  // model binding / skill set for this variant
  }],
  "routing": {
    "match": "skill-id",                // skill-id | header | route — how the needed cap is derived
    "fallbackVariant": "default",       // optional; else widen to all variants of the version
    "override": null                    // operator pin: variant id (skips capability/cost/latency)
  }
}
```
Cost signal source (resolved): **static per-variant `costEstimate`** (operator-supplied rank, or
derived from the price table) for v1; a `measured` mode swaps in observed cost later behind the same
`estCost()` call — no schema change.

## Load balancing across healthy replicas (stage 5 reuse, no new LB)
Stage 3 sets `ctx.variant` only. Stage 5 (`loadBalance`, epic 09) is **reused unchanged**: it filters
the registry to replicas matching `name@version#variant` AND `health == healthy` (health from the
worker registry / `/healthz`, C4/epic 09), then picks among them. An **unhealthy replica is never a
candidate**; if all replicas of the selected variant are unhealthy, stage 5 surfaces the existing
"no healthy target" error (it does **not** silently re-route to another variant — variant choice is
stage 3's contract).

## File-by-file
- **new** `router/stages/select-variant.ts` — stage 3 (`selectVariant`), registered at frozen index 3.
- **new** `router/capability-index.ts` — builds `tag → variant[]` from merged descriptor skill ids;
  validates each variant's `capabilities` is backed by its `skills`; persists under
  `_system/capability-index/<name>` (C3); rebuilt on `deploy`.
- **edit** `worker.schema.json` (C2) — add the `sharding` block above (`variants` + `routing`);
  TS-validated only.
- **reuse** `router/stages/load-balance.ts` (epic 09 stage 5) — extend its registry filter to the
  `name@version#variant` key; **no new LB logic**.
- **reuse** epic 09 `/metrics` EWMA + `/healthz` for `liveLatency()` and health filtering.

## Verification → test layers
- **L1:** `selectVariant` returns the only capability-matching variant; with ≥2 matches, the lower
  `costEstimate` wins, and on equal cost the lower live-latency wins; `override` short-circuits all
  signals; unmatched capability falls back per `fallbackVariant`.
- **L1:** capability-index build **rejects** a variant whose `capabilities` tag has no backing
  descriptor skill id.
- **L3/L4:** with ≥2 variants × ≥2 replicas behind one endpoint, requests for capability A land on
  variant A and B on variant B; load spreads across that variant's **healthy** replicas; an
  unhealthy replica receives no traffic; all-unhealthy → "no healthy target" (no cross-variant
  re-route).
