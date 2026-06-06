# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the major version is `0.x`, **minor bumps may contain breaking changes**;
patch bumps remain backwards-compatible. SemVer kicks in fully at `1.0.0`.

## [Unreleased]

## [0.2.0] — 2026-06-06

The **in-the-loop agent runtime** redesign. airlock now executes the agent step
by step and owns the loop, so the Operator controls every step, tool call, and
dollar *during* the run — harness-agnostic, self-hosted, the same Worker for
internal callers and the open internet. All 14 epics (00–13) built and tested.
Program of record: [`docs/redesign/`](docs/redesign/README.md). This is a
breaking release: payments are gone and the runtime/manifest surface is new.

### Added
- **Airlock Loop Engine** (`engine/`) — OWN step loop with `StepEvent`/`ControlSignal`, planner protocol, and per-step cost accounting ([ADR-0014](docs/adr/0014-airlock-owns-the-loop.md)).
- **Loop control & guards** — budget/$ stop, tool gating, and a `hold→decide→resume` approval gate over the control API.
- **Mid-run routing & fallback** — per-step model routing with model/tool fallback.
- **State, checkpoint, resume & fork** — pluggable `State Store` (`memory` + `sqlite`) with tenant-first keys, snapshots, run-index, held-runs, usage, and tool-result reuse; resume and fork-by-replay ([ADR-0016](docs/adr/0016-pluggable-state-store-sticky-routing.md)).
- **Step observability** — SSE step stream, per-step `cost_usd`, `/metrics`, traces, and a local **Operator Console** at `/console` (Overview, Live, Runs+trace, Approvals, Controls).
- **Sandboxed execution** — subprocess isolation + rlimits + SIGKILL wall-clock cap.
- **`worker.yaml` manifest** — one JSON-Schema (TS-validated via Ajv), manifest loader, variants/profiles, and per-skill on/off ([ADR-0015](docs/adr/0015-worker-yaml-single-manifest.md), [ADR-0020](docs/adr/0020-worker-yaml-single-schema-source.md)).
- **Versioning controls** — router stage with `promote`/`rollback` control API (canary + instant rollback).
- **Deploy, expose & fleet router** — reproducible content-hash Docker image, `airlock up --docker`, real multi-container `airlock deploy --replicas N [--canary]`, and a live router service (pipeline + reverse-proxy + control API) ([ADR-0017](docs/adr/0017-fleet-router.md)).
- **Multi-tenancy & identity** — api-key auth, tenant-scoped state and usage ([ADR-0018](docs/adr/0018-pluggable-caller-auth-multitenancy.md)).
- **Triggers** — signed webhook trigger.
- **Agentic sharding** — variant routing in the fleet router.
- **Contract shaping** — input guard, output enforce+redact, real `/skills/<id>` dispatch.
- **All 5 framework harnesses real** — LangGraph, smolagents, CrewAI, OpenAI Agents SDK, and Claude Agent SDK, all OWN via tool-extraction (`harnesses/extract.py`); live-verified against a local Qwen2.5-3B.
- **Durable tunnel auto-provisioning** — `airlock tunnel provision` zero-interaction creates the Cloudflare tunnel + DNS via the CF API; `up --durable --hostname` with no sudo; `.env` autoload.

### Changed
- **airlock owns the loop** — reverses the front-of-agent gateway / "runtime forbidden" framing; the Worker now drives the agent loop itself ([ADR-0014](docs/adr/0014-airlock-owns-the-loop.md)).
- **Inference stays external** — airlock makes the model calls; the model endpoint remains the Operator's ([ADR-0019](docs/adr/0019-inference-stays-external.md)).
- `CONTEXT.md` and the ADR ledger rewritten to runtime vocabulary (**Operator** replaces Publisher; Worker, Loop Engine, StepEvent/ControlSignal, Fleet Router, Tenant, State Store).

### Removed
- **x402 payments / crypto** — `payment-core`, `payment-workers`, `payment-fly-node`, `python/payment-fly`, the optional buy tool, and `docs/payment.md` (epic 00). `airlock-crypto` is out of scope.
- **airlock-directory + publisher heartbeat** — directory paused; ADR-0013 retired; the planned `airlock register` CLI is dropped.
- Legacy example deploy scaffolds (`agent-template`, `local-llm-agent`) and the Fly/Workers CLI templates.

### Deferred (not release-blocking)
Per-tenant rate/quota limits · MCP server wiring (schema block only) · redis/postgres state backends · JWT/OIDC auth · `worker.yaml` hot-reload · OTel exporter · durable fleet registry · py3.10 base bump + `[frameworks]` pip extra.

## [0.1.0] — 2026-05-28

First tagged release. Self-host is the supported deploy path; the ecosystem's directory and registry plumbing land alongside it.

### Added
- **Self-host flow** (`airlock up`) — runs your harness in-place behind a public Cloudflare quick tunnel; no account needed.
- **Durable self-host URL** (`airlock up --durable`) — stable hostname on a publisher-owned Cloudflare named tunnel, via `AIRLOCK_CF_TUNNEL_TOKEN`. Connector supervised with backoff reconnect.
- **Config-driven harness binding** — `airlock init --detect` autowires smolagents, LangGraph, CrewAI, OpenAI Agents SDK, and Claude Agent SDK; the shared `airlock-agent` runtime drives the native loop.
- **In-process x402 payment middleware** — Python (`payment-fly`) + TypeScript (`payment-workers`, `payment-fly-node`); flat and per-token (including streamed) pricing; settles via an external Facilitator.
- **Scale & latency** — latency-aware admission (EWMA + per-request budget → `429 Retry-After`), SSE streaming (Tier A heartbeat across every harness + Tier B `run_stream` mechanism), per-token streamed billing, `/metrics`. Connector tuning via `--cf-protocol` / `--cf-region` / `--cf-metrics`.
- **Capped-parallel concurrency** — per-call agent isolation (ADR-0010) + bounded queue.
- **Optional buy tool** — `airlock-agent[crypto]` wires the [`airlock-crypto`](https://github.com/Okohedeki/airlock-crypto) wallet so an agent can pay other agents' x402 paywalls.
- **Dashboard backend** — GitHub OAuth, project registration, inspect store.
- **Environment-variable docs** in the README — first-class reference for what to set per use case.

### Changed
- Documented as **self-host only** in the README; removed the dual "deploy to your cloud" framing.
- `airlock-config search.ts` repointed off the stale `airlock-config-registry` static URL onto the new airlock-directory PostgREST endpoint.

### Removed
- **Fly deploy from the deploy surface** (`exec.ts` `buildDeploy/buildDelete/buildLogs/buildSecret/buildDomain`, `doctor.ts` target validation, `exec.test.ts` Fly assertions). Legacy `target='fly'` configs now fail with a clear error pointing at `airlock up`.
- 12 example deploy scaffolds: `examples/{agent-template,claude-agent,crewai-agent,langgraph-agent,openai-agents-agent,smolagent-local}/fly.toml` + `Dockerfile`.
- `docs/llama-cpp-on-fly.md`.

### Ecosystem (shipped alongside)
- **`airlock-directory`** — first cut of the searchable "find" layer: Supabase agents table + read-only RLS, public `register` Edge Function (fetches the publisher's contract, validates v0.5 shape, enforces trust-on-first-use host check), zero-build static site at [`airlock-directory.pages.dev`](https://airlock-directory.pages.dev).
- **`airlock-config@0.5`** — registry helpers wired to the live directory; full `search`/`register-entry` flow against the Supabase view.

### Known gaps
- The `airlock init` command still defaults to `--target=fly` and gates Python-harness scaffolding on it; this flow's templates are named `fly-*` historically. Surface-level deploy/doctor enforce workers-only, so legacy configs fail loudly — but a deeper init-flow cleanup is queued for `0.2.0`.
- `airlock register` CLI (publisher → airlock-directory) is specified in MEMORY but not yet implemented.

[Unreleased]: https://github.com/Okohedeki/airlock/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Okohedeki/airlock/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Okohedeki/airlock/releases/tag/v0.1.0
