# airlock redesign — in-the-loop agent runtime

This directory is the program of record for the airlock redesign. The north star is
[`PRODUCT-BRIEF.md`](./PRODUCT-BRIEF.md); the work is decomposed into curated **epics** under
[`plans/`](./plans/). Each epic is independently grabbable but ordered by the dependency graph
below.

## Vision

airlock becomes an **in-the-loop agent runtime**: it executes the agent *step by step* so the
operator controls every step, tool call, and dollar **during** the run — harness-agnostic,
self-hosted, and the **same worker** whether it serves internal callers or the open internet. The
moat is **control the loop**, which a front-of-agent gateway structurally cannot copy.

**The blocker this redesign solves:** today each harness adapter runs the framework's own opaque
loop (`adapter.run(messages) → AgentRunResult`); airlock sees only the final answer. Only
LangGraph + Claude SDK expose step seams; smolagents/CrewAI/OpenAI Agents are black boxes. There
is no step/checkpoint/session/state machinery, and the runtime is stateless by design (ADR-0011).
The whole differentiator requires inverting this.

## Locked decisions (architecture)

- **Airlock owns the loop** — the runtime is the orchestrator (model calls + tool dispatch),
  emitting a uniform `StepEvent` stream and consuming `ControlSignal`s.
- **All five harnesses + custom** get full step-control; frameworks contribute tools/planners/
  prompts, airlock runs the loop.
- **Hooks are out of v1 scope** — the harness keeps control of hooks.
- **Skills flatten to tools** — a skill IS a callable; MCP-provided tools are skills too; the
  airlock-config skill schema is still used for typed I/O validation.
- **`worker.yaml`** is the single operational manifest, migrated from `.airlock/config.toml`.
  `airlock-config` is narrowed to the **buyer-facing descriptor** of the deployed agent
  (validated + served at `/.well-known`; supplies skill schemas).
- **Interface** = OpenAI-chat (`/v1/chat/completions`) + typed `/skills/<id>`; internal vs
  external = network binding + auth only.
- **Pluggable state store** (SQLite/files default; Redis/Postgres for scale) + **sticky routing**
  (revisits ADR-0011).
- **Packaging** = the `airlockhq/airlock` Docker image + a no-Node shim (delivers ADR-0012).
- **Fleet router** in front of the worker fleet for version/variant/canary routing + sharding +
  LB; control stays inside each worker.
- **Pluggable caller auth** (API key | JWT/OIDC | mTLS); per-tenant state/limits/usage.

See each epic for the feature-level mechanics (intervention channels/methods, guard-breach,
retry/fallback, tool cache, streaming content, canary gating, triggers, sharding signals,
contract I/O, trace privacy, etc.).

## Architecture (the reframes)

1. **Airlock Loop Engine** (in-worker keystone) — owns the loop; `StepEvent`/`ControlSignal`.
2. **`worker.yaml`** — single operational manifest (compose + controls + routing + io + triggers
   + expose + tenancy + price table).
3. **State substrate** — pluggable store: run snapshots, sessions, tool-result cache, tenant
   state; sticky routing.
4. **Fleet router** — version/variant/canary routing, sharding, LB.
5. **Packaging** — `airlockhq/airlock` image + no-Node shim; one-command deploy.
6. **airlock-config** — descriptor-only; served at `/.well-known`; supplies skill schemas.
7. **Observability plane** — dashboard + Prometheus + OTel; live step streaming; redacted traces.
8. **Multi-tenancy & auth** — pluggable caller auth; per-tenant isolation/limits/usage.

## Epics

| # | Epic | Brief group | Depends on | Status |
|---|------|-------------|-----------|--------|
| [00](./plans/00-foundations-strip-crypto-config-reset.md) | Foundations: strip crypto + airlock-config descriptor reset + `worker.yaml` migration | (cleanup) | — | ✅ **Done** (branch `redesign/epic-00-foundations`) |
| [01](./plans/01-airlock-loop-engine.md) | **Airlock Loop Engine** (keystone) | Control the loop | 00 | Planned |
| [02](./plans/02-loop-control-and-guards.md) | Loop control & guards (+ mid-run intervention) | Control the loop | 01, 04, 05 | Planned |
| [03](./plans/03-midrun-routing-and-fallback.md) | Mid-run routing & fallback | Control the loop | 01, 07 | Planned |
| [04](./plans/04-state-checkpoint-resume-replay-fork.md) | State, checkpoint/resume, replay/fork, tool-result reuse | Control the loop + State | 01, 09 | Planned |
| [05](./plans/05-step-observability.md) | Step observability (streaming + per-step cost/latency) | Control the loop | 01, 04 | Planned |
| [06](./plans/06-sandboxed-execution.md) | Sandboxed execution | Control the loop | 01 | Planned |
| [07](./plans/07-worker-manifest-and-composition.md) | Worker manifest & composition | Compose the worker | 00 | Planned |
| [08](./plans/08-versioning-canary-rollback.md) | Versioning: canary & instant rollback | Compose the worker | 07, 09 | Planned |
| [09](./plans/09-deploy-expose-and-fleet-router.md) | Deploy, expose & fleet router | Deploy & expose | 07 | Planned |
| [10](./plans/10-multitenancy-and-customer-identity.md) | Multi-tenancy & customer identity | Deploy & expose | 04, 09 | Planned |
| [11](./plans/11-triggers.md) | Triggers (cron / webhook / event) | Deploy & expose | 09 | Planned |
| [12](./plans/12-agentic-sharding.md) | Agentic sharding | Deploy & expose | 09 | Planned |
| [13](./plans/13-contract-shaping-input-output.md) | Contract shaping: controlled input/output | Shape the contract | 07, 01, 00 | Planned |

**Dependency order:** 00 → {07 manifest, 01 engine} → {02, 03, 05, 06, 13} on the engine; 04
alongside 01; 09 (Docker/router/expose) → {08, 10, 11, 12}. "Control the loop" (01–06) is the
differentiator.

## Execution strategy (2026-06-03): plan + build ALL epics together

Epic 00 is **done**. The remaining epics (01–13) are **not** executed one-at-a-time (not 01, then
decide, then 02). The next phase is:

1. **One comprehensive planning pass over all 13 remaining epics** — detailed, build-ready
   implementation plans for 01–13 produced together, as a set.
2. **A coordinated full build-out** — implement them in one push, parallelized across the
   dependency graph above (independent epics built concurrently, e.g. via subagents/workflows),
   rather than ship-one-and-wait.

The dependency graph still orders the **build** (you can't build 02 before 01, or 08 before 09),
but **planning is all-at-once** and execution is a single coordinated effort. Do not pause after a
single epic to re-scope the program — the program is this document.

Testing follows the same all-at-once intent: see [`../testing-e2e.md`](../testing-e2e.md) for the
layered suite and which scenarios are automatable via Claude + subagents.

## Brief feature → epic map

Every bullet in the brief's Features section maps to exactly one epic.

| Brief feature | Epic |
|---------------|------|
| Operate any step (pause/retry/resume/kill) | 01 + 02 |
| Loop guards (max steps, token/cost budget mid-run) | 02 |
| Mid-run intervention (hold/approve, inject guidance) | 02 |
| Per-step tool gating (by arguments) | 02 |
| Mid-run model routing | 03 |
| Mid-run fallback | 03 |
| Checkpoint & resume | 04 |
| Replay & fork | 04 |
| Tool-result reuse | 04 |
| Sandboxed execution | 06 |
| Live step streaming | 05 |
| Per-step cost & latency | 05 |
| A worker, not an output | 07 |
| Built from parts (skills, MCP, tools, model binding) | 07 |
| One YAML manifest | 07 |
| Harness-agnostic | 07 (+ 01 engine) |
| Releasable in pieces | 07 (dev) + 08 (prod) |
| Versioned with canary + instant rollback | 08 |
| One command to ship | 09 |
| Internal service | 09 |
| Expose to the internet | 09 |
| Customer identification | 10 |
| Scheduled & event-triggered | 11 |
| Agentic sharding | 12 |
| Controlled input | 13 |
| Controlled output | 13 |
| State tracking | 04 |

**Deferred / out of v1 scope:** *hooks* ("built from parts" lists hooks, but airlock does not
implement its own hook lifecycle in v1 — the harness/framework keeps control of hooks). Stronger
sandbox isolation (container/microVM/WASM), model-based I/O guards, and auto-promote canary are
explicitly later-phase within their epics.

## Status of prior decisions

This redesign is the source of truth. The pre-redesign [ADR ledger](../adr/) has been
reconciled — each old ADR now carries a status marker, and the architectural
reversals are recorded as new ADRs. The root [`CONTEXT.md`](../../CONTEXT.md) glossary
has been rewritten to this program's vocabulary (Operator, Worker, Loop Engine,
StepEvent/ControlSignal, Fleet Router, Tenant, …).

Supersedes the stale [`../PLAN.md`](../PLAN.md) (Cloudflare-Workers-codegen v1 sketch).

### Pre-redesign ADRs

| ADR | Disposition | By |
|-----|-------------|----|
| [0001](../adr/0001-we-operate-the-hosted-dev-tunnel.md) hosted dev tunnel | Superseded | epic 09 / ADR-0017 |
| [0002](../adr/0002-dev-is-free-prod-is-paid.md) dev-free/prod-paid | Superseded | epic 00 |
| [0003](../adr/0003-two-targets-at-v1.md) two targets | Superseded | epic 09 / ADR-0017 |
| [0004](../adr/0004-open-source-first.md) open-source-first | **Accepted (survives)** | restated in CONTEXT.md |
| [0005](../adr/0005-x402-for-monetization.md) x402 | Superseded | epic 00 |
| [0006](../adr/0006-wallets-in-airlock-crypto.md) wallets | Superseded | epic 00 |
| [0007](../adr/0007-harness-adapter-interface.md) harness adapter | Superseded | ADR-0014 / epic 01 |
| [0008](../adr/0008-airlock-never-hosts-inference.md) never hosts inference | Superseded | ADR-0019 (invariant carried forward) |
| [0010](../adr/0010-per-call-agent-isolation.md) per-call isolation | Revisited | ADR-0014/0016 / epics 01,04 |
| [0011](../adr/0011-scaling-on-cloudflare-named-tunnel-replicas.md) stateless replicas | Superseded | ADR-0016/0017 / epics 04,09 |
| [0012](../adr/0012-docker-first-runtime-model-external.md) docker-first | **Accepted (aligned)** | delivered by epic 09 |
| [0013](../adr/0013-directory-liveness-via-publisher-heartbeat.md) directory heartbeat | Retired | directory paused |

### New ADRs (the redesign's reversals)

| ADR | Decision | Owning epic |
|-----|----------|-------------|
| [0014](../adr/0014-airlock-owns-the-loop.md) | Airlock owns the loop (keystone) | 01 |
| [0015](../adr/0015-worker-yaml-single-manifest.md) | `worker.yaml` as single operational manifest | 07 (00) |
| [0016](../adr/0016-pluggable-state-store-sticky-routing.md) | Pluggable state store + sticky routing | 04 |
| [0017](../adr/0017-fleet-router.md) | Fleet router | 09 |
| [0018](../adr/0018-pluggable-caller-auth-multitenancy.md) | Pluggable caller auth + multi-tenancy | 10 |
| [0019](../adr/0019-inference-stays-external.md) | Inference stays external; airlock orchestrates calls | 01/09 |
