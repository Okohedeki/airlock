# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the major version is `0.x`, **minor bumps may contain breaking changes**;
patch bumps remain backwards-compatible. SemVer kicks in fully at `1.0.0`.

## [Unreleased]

### Decided (direction for v1 — no code yet)
- **Docker-first runtime** ([ADR-0012](docs/adr/0012-docker-first-runtime-model-external.md)) — v1 ships as one `airlockhq/airlock` image + a no-Node `airlock` shim; Python is pinned in the image, the model is always an external URL. **Reverses** the earlier "no Docker / native + uv bootstrap" direction. Resolves the new-user install gap (missing/wrong Python) and the opaque 120s startup timeout.
- **Directory liveness via publisher heartbeat** ([ADR-0013](docs/adr/0013-directory-liveness-via-publisher-heartbeat.md)) — `airlock up` heartbeats the directory with a per-agent anti-spoof token; status is "last seen," computed at read time. Reachability poller deferred.
- **v1 bar = "a stranger installs on a fresh machine and goes live"** — scope (P0+P1) and the fresh-machine smoke-test gate captured in the v1-readiness review.

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

[Unreleased]: https://github.com/Okohedeki/airlock/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Okohedeki/airlock/releases/tag/v0.1.0
