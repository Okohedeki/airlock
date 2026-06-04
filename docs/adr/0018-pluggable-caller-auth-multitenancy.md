# Pluggable caller auth + multi-tenancy

> **Status (2026-06-03): Accepted.** Redesign [epic 10](../redesign/plans/10-multitenancy-and-customer-identity.md).

A Worker authenticates its **Callers** through pluggable auth middleware declared in
`worker.yaml` — API key, JWT/OIDC, or mTLS — and derives a **Tenant** id from the
credential. Tenant id keys per-tenant state and sessions
([ADR-0016](./0016-pluggable-state-store-sticky-routing.md)), scopes limits, and
drives usage metering (calls, steps, tokens, cost). **Internal vs. external is only
a difference of network binding + auth method** — the same Worker, the same routes
([epic 09](../redesign/plans/09-deploy-expose-and-fleet-router.md)).

This replaces the old single-user-per-deployment model and the retired
payment/Caller-as-payer identity ([ADR-0005](./0005-x402-for-monetization.md)) with
a generic, operator-pluggable identity layer.

## Considered Options

- **One hard-wired auth scheme (rejected).** Operators standardizing across many
  internal teams already have an IdP (OIDC) or a service mesh (mTLS); forcing one
  scheme blocks the primary buyer persona.
- **No built-in tenancy; operator bolts it on (rejected).** Per-tenant state,
  limits, and usage are exactly what the multi-tenant story needs; leaving it out
  pushes the hard part onto every operator.
- **Pluggable auth + tenant-keyed isolation (accepted).** Covers internal (mTLS/
  OIDC) and external (API key) from one Worker, with isolation derived from the
  credential.

## Consequences

- Same routes serve internal and external callers; only binding + auth differ.
- Approver authorization for human-in-the-loop gates (epic 02) ties into this auth
  layer.
- API-key issuance/storage and the JWT/OIDC-claim→tenant mapping are open questions
  in epic 10.
