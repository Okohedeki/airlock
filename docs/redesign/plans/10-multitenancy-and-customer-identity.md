# Epic 10 — Multi-tenancy & customer identity

## Context
To expose a worker to many customers (the secondary buyer) and to let internal teams share one
worker safely (the primary buyer), airlock must authenticate each caller, isolate state and
enforce limits per customer, and track usage — multi-tenant from the same worker. Today there is
no auth and one shared concurrency/queue for all callers.

## Scope
- **Customer identification:** authenticate each caller.
- **Per-tenant isolation:** isolate state and enforce limits per customer.
- **Usage tracking:** attribute usage per customer.

## Dependencies
04 (per-tenant state + sessions), 09 (exposure + the auth layer applies on public expose).

## Design (locked: pluggable auth)
- **Pluggable auth middleware** configured in `worker.yaml` `auth:` — **API key | JWT/OIDC | mTLS**.
  The middleware derives a **tenant id** from the credential.
- **Per-tenant isolation:** the tenant id keys (a) **state + sessions** (epic 04, sessions are
  caller/tenant-scoped by default), and (b) **limits** — extend the admission gate
  (`concurrency.py`) with per-tenant concurrency/queue/rate caps rather than one global gate.
- **Usage metering:** per-tenant counters (calls, steps, tokens, $) keyed off the tenant id,
  surfaced in the dashboard (epic 05).
- Internal vs external (epic 09) only changes *which* auth method is required (e.g. mTLS/JWT
  internally, API key publicly) — same worker.

## Key files
`auth/` middleware in the runtime; per-tenant gate in `concurrency.py`; state keys (epic 04);
usage counters + dashboard (epic 05); `worker.yaml` `auth`/`tenancy` schema.

## Open questions
- API-key issuance/storage (airlock-managed key store vs operator-provided) — likely operator-
  provided for v1, with a simple local key store option.
- Per-tenant limit defaults + override precedence vs global limits.
- JWT/OIDC claim → tenant-id mapping configuration.

## Verification
- Two tenants get **isolated state** and **independent limits** (one tenant saturating its quota
  doesn't starve the other).
- Usage is attributed per tenant in the dashboard.
- An unauthenticated/invalid-credential call is rejected before the loop runs.

---

# Build-ready spec (frozen contracts)

> Frozen 2026-06-04. **Tenant is resolved at router stage 1, before any model call; isolation is
> structural via `store.scoped(tenant)` (C3); limits are per-tenant.** Consumes C2 (worker.schema),
> C3 (State Store), C4 (router pipeline). Owns C4 **stage 1 `authResolveTenant`**.

## Auth middleware — `airlock_agent/auth/` (new)
- `middleware.py` — `resolve_tenant(request, cfg) -> TenantCtx | AuthError`. Tries the configured
  scheme(s) in order; returns `TenantCtx(tenant, claims, scheme)` or an `AuthError` (→ 401/403). **No
  model call, no loop, no store handle is built until this returns ok.**
- `apikey.py` — **operator-provided keys for v1 (resolves open question): airlock validates, does
  not issue.** Keys live in the State Store under `_system/apikeys/{sha256(key)}` → `{tenant}` (and
  a `files`/env source for zero-dep self-host). Constant-time compare; never log the raw key.
- `jwt.py` — JWT/OIDC: verify signature against `tenancy.oidc.jwks_url` (cached), then map a claim
  to the tenant id via `tenancy.claim_to_tenant` (e.g. `org_id` → tenant). mTLS is a later scheme
  behind the same interface (cert CN/SAN → tenant).
- Single-tenant default: when `auth` is absent, every caller resolves to `tenant="default"` (C3).

## Router stage 1 — `authResolveTenant` (C4, pre-loop)
`router/stages/authResolveTenant.ts` fills `ctx.tenant`. It calls the runtime auth middleware (or
validates locally for API keys), **rejects unauthenticated/invalid before `next()`** so stages 2–5
(version, variant, sticky, LB) and the loop never run for an unauthed caller. Being stage 1 is what
lets version pins + limits be per-tenant downstream. On reject: 401 (missing/bad cred) / 403
(valid cred, unknown tenant), with no body leakage about which tenants exist.

## Per-tenant isolation (C3)
The resolved `tenant` is the **only** way downstream code reaches state: `surface.py` calls
`store.scoped(ctx.tenant)` once and hands the `ScopedStore` to the loop, sessions, and cache.
Callers receive `rest = "{session}/{run}/{kind}/{id}"` and **cannot** prepend another tenant — the
key builder always emits `{tenant}/…` (C3). `scoped("acme").list_prefix("")` enumerates only
`acme/…`; there is no API that takes a raw cross-tenant key. Cross-tenant data (apikeys, registries)
lives under the reserved `_system/` prefix, never reachable from a `ScopedStore`.

## Per-tenant limits — `concurrency.py` (extend `BoundedGate`/`ConcurrencyPolicy`)
One global gate lets a noisy tenant starve others. Add a **`TenantGate` registry**: a lazily-created
`BoundedGate` per tenant (keyed by tenant id), each with its own `max_concurrency`/`max_queue`/
`max_wait`. `acquire()` is dispatched by `ctx.tenant` so one tenant saturating its slots only sheds
**its own** overflow (429), never another tenant's. Resolves the limits open question:
**precedence = manifest `tenancy.defaults` < per-tenant `tenancy.tenants.{id}.limits`** (per-tenant
override wins; absent → manifest default; absent → env-var globals already read by `read_*`). Usage
counters and per-tenant `stats()` surface saturation.

## Usage tracking
On run completion the runtime increments per-tenant counters in the State Store under the reserved,
**tenant-prefixed** key `{tenant}/_usage/{period}` → `{calls, steps, tokens, cost_estimate}`
(append/increment, TTL by retention). Epic 05's dashboard reads these per tenant; nothing surfaces a
tenant's usage to another tenant. Counters are written *after* the gate, so shed (429) calls don't
inflate usage.

## Schema — `auth`/`tenancy` blocks in `packages/cli/src/worker-schema/worker.schema.json` (C2)
TS-validated only (C2):
```yaml
auth:
  scheme: [apikey] | [jwt] | [apikey, jwt] | [mtls]   # tried in order; omit → single-tenant "default"
tenancy:
  claim_to_tenant: { claim: org_id }                  # JWT/OIDC claim → tenant id
  oidc: { issuer: ..., jwks_url: ... }                # required when scheme includes jwt
  defaults: { max_concurrency: 4, max_queue: 50, max_wait_s: 120 }   # per-tenant default caps
  tenants:                                            # optional per-tenant overrides (win over defaults)
    acme: { limits: { max_concurrency: 16 } }
```

## File-by-file
- **new** `airlock_agent/auth/{middleware.py, apikey.py, jwt.py}` (mTLS later, same interface).
- **new** `router/stages/authResolveTenant.ts` — C4 stage 1; sets `ctx.tenant`; rejects pre-loop.
- **edit** `concurrency.py` — `TenantGate` registry (per-tenant `BoundedGate`); `resolve_policy`
  takes per-tenant limits with manifest-default fallback.
- **edit** `surface.py` — call auth middleware result → `store.scoped(tenant)`; pass scoped handle +
  tenant gate into the run; write `_usage/` counters on completion.
- **schema** — `auth` + `tenancy` blocks in `worker.schema.json` (C2).
- **reuse** State Store (C3) for apikeys (`_system/apikeys/…`), state/sessions/cache (`{tenant}/…`),
  usage (`{tenant}/_usage/…`); dashboard tie-in (epic 05).

## Verification → test layers
- **L1:** key builder always emits `{tenant}/…`; `TenantGate` dispatches by tenant; precedence —
  per-tenant override beats manifest default beats env global; usage written only after gate admit.
- **L2 (isolation):** tenant B cannot `list_prefix` into tenant A's state/sessions/cache; usage
  counters land under the right tenant only.
- **L2 (limits):** tenant A saturates its gate → A's overflow 429s while **tenant B's calls still
  admit** (independent limits; no starvation).
- **L3:** an unauthenticated/invalid-credential call is rejected at stage 1 with **no model call /
  loop execution**; a valid cred for an unknown tenant → 403.
