# Epic 08 — Versioning: canary & instant rollback

## Context
"Releasable in pieces" and production safety require versioning the worker, shipping a change to a
slice of traffic, comparing, and promoting or rolling back in one command. Scaling today is N
stateless Cloudflare tunnel replicas with no router and no version concept; this epic adds versions
on top of the fleet router (epic 09).

## Scope
- Content-addressed worker versions.
- Canary: ship a new version to a traffic slice; compare; **promote or instant-rollback in one
  command**.

## Dependencies
07 (manifest = the versioned artifact), 09 (fleet router does the traffic split).

## Design (locked: metrics-gated, manual promote)
- Each `worker.yaml` (+ its code/assets) produces a **content-addressed version**, recorded in a
  version registry in the state store (epic 04).
- The **fleet router (09)** does weighted/canary splits: route X% to the canary version, the rest
  to stable.
- **Decision = metrics-gated, manual:** airlock surfaces canary-vs-stable on **error rate /
  latency / cost** (and **eval pass-rate** if a worker declares evals); the operator
  **promotes** (`airlock promote`) or **instant-rolls-back** (`airlock rollback`) in one command.
  (Auto-promote on thresholds is a documented later-phase option.)
- Prod piece-changes from epic 07 mint new versions through this pipeline.

## Key files
Version registry (state store, epic 04); router split config (epic 09); CLI `deploy`/`promote`/
`rollback`; dashboard canary-vs-stable comparison view (`packages/server`).

## Open questions
- Comparison window + minimum-sample gating before promote is meaningful.
- How evals are declared/run for the optional eval pass-rate signal.
- Rollback atomicity across multiple replicas (router flip vs per-replica drain).

## Verification
- Deploy v2 at 10% → router splits traffic; dashboard shows v2 vs v1 on error/latency/cost.
- `airlock promote` shifts 100% to v2; `airlock rollback` instantly returns to v1.

---

# Build-ready spec (frozen contracts)

> Frozen 2026-06-04. **Versions are content-addressed; canary state is operational, not manifest;
> stickiness wins over canary.** Owns router pipeline **stage 2 `selectVersion`** (C4) and the
> version registry under `_system/versions/…` (C3). Builds on epics 09 (router/registry), 04
> (store), 07 (manifest/version artifact), 05 (metrics). Does **not** redefine C2/C3/C4 types.

## Content-addressed worker version (mint)
A version id = `sha256` of the **canonicalized validated manifest** (the TS-validated `worker.yaml`
object, JSON-canonical: sorted keys, no whitespace) **+ code/asset refs** (image digest from epic
09, plus content hashes of any local code/asset bundles). `verId = "v" + hash.slice(0,12)`. Minting
is pure: same manifest + same code ⇒ same id (idempotent re-deploy is a no-op). Every prod
piece-change from epic 07 re-validates → re-hashes → mints a new `verId` and enters the canary
pipeline here.

## Where canary/version state lives (C2 vs C3 decision)
**Operational state, NOT manifest.** `worker.schema.json` (C2) gains **no** version/canary fields —
a manifest must hash identically regardless of rollout state, so canary % and the live pointer are
*registry* state, not declared in `worker.yaml`. The **one optional manifest hook** is `evals` (a
declared eval suite ref + `passRateMin`) used as an OPTIONAL promote signal; it does not affect the
version hash only if excluded from the canonical form — to keep it simple, **`evals` IS part of the
hashed manifest** (changing your eval suite mints a new version, which is correct).

## Version registry (C3 — `_system/versions/…`, cross-tenant, reserved prefix)
Accessed via the unscoped `StateStore` (the `_system/` prefix bypasses `scoped(tenant)` by design;
this is the one cross-tenant registry alongside epic-09 `_system/workers/`). Keys:

```
_system/versions/{worker}/{ver}              # VersionMeta: {ver, manifestHash, codeRefs, createdAt, evals?}
_system/versions/{worker}/_rollout           # Rollout pointer (SINGLE atomic doc — see rollback)
```

```ts
interface Rollout {            // the ONE doc the router reads on every new session
  stable: string;              // verId receiving the non-canary share
  canary?: { ver: string; pct: number };  // absent = no canary in flight
  prior?: string;              // last stable, for instant rollback
  gate: { minRequests: number; minDurationS: number };  // promote-meaningful gating
  updatedAt: number;
}
```

`scoped(session)` pins (under the C3 session namespace, written by stage 2): `…/version` → `verId`.

## Router stage 2 `selectVersion` (C4 — frozen pipeline order, no-op for existing sessions)
```ts
const selectVersion: Stage = async (ctx, next) => {
  const pinKey = `${ctx.tenant}/${ctx.sessionId}/version`;
  const pinned = ctx.sessionId && (await store.get(pinKey));   // C3 read
  if (pinned) { ctx.version = pinned; return next(); }          // EXISTING session → no-op
  const r: Rollout = await store.get(`_system/versions/${worker}/_rollout`);
  ctx.version = bucket(r, ctx);                                 // NEW session → split by pct
  if (ctx.sessionId) await store.set(pinKey, ctx.version);      // RECORD the pin
  return next();
};
// bucket(): if canary && hash(sessionId|requestId) % 100 < canary.pct → canary.ver else stable.
```

### Stickiness wins over canary (the subtle part — frozen mechanics)
- **Decided once, at session start.** A new session is bucketed by `canary.pct` and the chosen
  `verId` is **written to the session's State Store record** before routing proceeds.
- **Pinned thereafter.** On every subsequent request in that session, stage 2 finds the pin and is a
  **pure no-op** (sets `ctx.version` from the pin, never re-rolls the dice). Stage 4 `stickyAffinity`
  (epic 04) then resolves the replica honoring `ctx.version`.
- **A live session never flips version mid-run** — even if the operator `promote`s or `rollback`s
  while the session is open, the pin holds for that session's lifetime (TTL per epic-04 sessions).
- **Canary still ramps** because *new* sessions are bucketed against the *current* `_rollout` doc:
  raising `canary.pct` shifts only new-session distribution. Trade-off (locked, per C4):
  conversational consistency over fastest canary signal.
- **Anonymous/sessionless requests** (no `sessionId`) are bucketed per request, not pinned.

## CLI — `exec.ts` builders + `cli.ts` wiring
- **`airlock deploy worker.yaml [--canary N]`** — validate (C2) → mint `verId` → write `VersionMeta`
  → write `_rollout` with `canary={ver, pct:N}` (default N=10), `stable` unchanged, `prior` untouched.
  Also runs the container + registers the worker (epic 09). N=0 / `--no-canary` ⇒ mint only, no split.
- **`airlock promote [<ver>]`** — set `stable = canary.ver` (or arg), clear `canary`, set
  `prior = <old stable>`. **Gated:** refuses unless the canary has met `gate.minRequests` +
  `gate.minDurationS` (override with `--force`). One `_rollout` write.
- **`airlock rollback`** — set `stable = prior`, clear `canary`. **Instant + atomic across replicas:**
  it is **one write to the single `_rollout` doc**; every router replica reads that one pointer on
  the next new session, so all replicas observe the flip simultaneously (no per-replica drain, no
  fan-out). Resolves the rollback-atomicity open question: **single registry pointer, one atomic
  write.** (In-flight pinned sessions ride their pin to completion — see stickiness.)

## Comparison dashboard — `packages/server`
Canary-vs-stable panel grouped by `ctx.version`, sourced from **epic-05 StepEvent metrics**
(error rate / p50+p95 latency / cost per request). Resolves open questions:
- **Window + min-sample gating:** comparison aggregates over a configurable rolling window; promote
  is flagged "meaningful" only once `canary` has ≥ `gate.minRequests` AND ≥ `gate.minDurationS`
  (defaults e.g. 200 req / 600 s). The promote button is disabled (CLI refuses) until then.
- **Evals (OPTIONAL):** if the manifest declares `evals`, show canary eval pass-rate vs `passRateMin`
  as an additional column. Absent ⇒ panel omits it. Eval execution itself is out of scope here
  (declared signal only).

## File-by-file
- **new** `router/stages/select-version.ts` — stage 2 implementation (read pin → no-op | bucket+pin).
- **new** `router/version-registry.ts` — C3 client for `_system/versions/…` (mint, get rollout,
  put rollout, getMeta); `bucket()` + `hash()` helpers.
- **edit** `exec.ts` — `deploy` (mint+rollout), `promote` (gated), `rollback` (one write) builders.
- **edit** `cli.ts` — register `deploy --canary`, `promote [ver] --force`, `rollback`.
- **new** `packages/server/` canary-comparison view — reads epic-05 metrics keyed by version.
- **schema** — **no change** to `worker.schema.json` except the **optional `evals`** block (C2).
- **reuse** `_system/` registry via the unscoped `StateStore` (C3); router pipeline (C4).

## Verification → test layers
- **L1:** `mint()` is deterministic (same manifest+code ⇒ same `verId`; any field change ⇒ new id).
  `bucket()` honors `pct` (10% canary ⇒ ~10% of new sessions on v2). `selectVersion` is a no-op when
  a pin exists. Promote gating refuses below `minRequests`/`minDurationS`.
- **L2:** deploy v2 @10% → new sessions split ~90/10; a session pinned to v1 **stays on v1** across
  many calls after the canary starts; a fresh session can land on v2.
- **L3/L4:** `promote` → `_rollout.stable=v2`, all new sessions → v2; `rollback` → `_rollout.stable`
  back to v1 in **one registry write**, observed by all router replicas; in-flight pinned sessions
  unaffected. Dashboard shows v2-vs-v1 error/latency/cost and gates the promote button.
