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
