# Epic 04 — State, checkpoint/resume, replay/fork, tool-result reuse

## Context
The brief's State group and several control-the-loop features need persistence the runtime does
not have today: it is stateless by design (ADR-0011, so any replica can serve any request). This
epic introduces a state substrate for run snapshots, sessions, a tool-result cache, and per-tenant
state — and accepts that this **revisits ADR-0011** via sticky routing.

## Scope
- **State tracking:** session + run state held across steps and across calls.
- **Checkpoint & resume:** per-step snapshots; resume a failed run from the last good step.
- **Replay & fork:** re-run a past run; fork from step N with one change.
- **Tool-result reuse:** cache an expensive tool call and reuse it across runs.

## Dependencies
01 (engine snapshot hooks). 09 (fleet router) for sticky routing. Consumed by 02 (held-run
parking), 05 (trace store), 10 (per-tenant state).

## Design
- **Pluggable state store** (`airlock_agent/state/`): an interface + adapters — default
  **SQLite/files** (self-host), **Redis/Postgres** for scale. Holds: run snapshots (per step),
  **sessions**, the **tool-result cache**, and tenant state.
- **Sessions (locked):** caller/tenant-scoped by default; an explicit `X-Airlock-Session` header
  overrides for multiple concurrent sessions; retention **TTL** configured in `worker.yaml`.
- **Snapshots:** the engine writes a snapshot after each step (working context + step index).
  **Resume** rehydrates the engine at the last good step. **Fork** copies a run up to step N and
  re-executes forward with the change.
- **Time-travel (locked) = record tool results, re-run model calls.** Tool results are recorded;
  on replay/fork the recorded results are re-fed (no re-execution of side effects), while model
  calls re-run live (not bit-deterministic, but cheap-side-effects-stable). This pairs with:
- **Tool-result cache (locked):** **opt-in per tool**, **cross-run per-tenant**, key =
  tool + args (+ model where relevant), with **TTL + manual bust**. **Side-effecting tools
  (send/pay/write) are never cached.**
- **Sticky routing:** so a resumed/forked run reaches the replica (or shared store) holding its
  state. Implemented with the fleet router (epic 09) — either affinity by run/session id, or a
  shared store so any replica can rehydrate. Records the ADR-0011 revisit.

## Key files
New `airlock_agent/state/` (store interface + SQLite/files/Redis/Postgres adapters); engine
snapshot/replay hooks (epic 01); router sticky logic (epic 09); `worker.yaml` `state`/`sessions`/
`cache` schema.

## Open questions
- Snapshot granularity/size (full context vs deltas) and serialization of harness-specific state.
- Affinity vs shared-store as the default sticky mechanism for v1.
- Cache key stability across model/binding changes.

## Verification
- Kill a run mid-flight, then resume → it completes **without re-running cached tools**.
- Fork from step N → output diverges only after N.
- Two calls in one session share state across calls within the TTL; a new session starts blind.
- A cacheable tool's second call (same args, same tenant) is served from cache; a send/pay/write
  tool is never cached.
