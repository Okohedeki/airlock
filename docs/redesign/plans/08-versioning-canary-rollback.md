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
