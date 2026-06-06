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

---

# Build-ready spec (frozen contract C3)

> Frozen 2026-06-04. **One Store protocol; tenant-first hierarchical keys; isolation is
> structural.** See [ADR-0016 §"tenant-first key namespace"](../../adr/0016-pluggable-state-store-sticky-routing.md).
> Consumed by epics 02 (held runs), 05 (traces), 10 (per-tenant state) — they key into *this*
> namespace via `scoped(tenant)`, never raw keys.

## Frozen protocol — `airlock_agent/state/store.py`

```python
from typing import Protocol, runtime_checkable, Any, Iterator

@runtime_checkable
class StateStore(Protocol):
    def get(self, key: str) -> Any | None: ...
    def set(self, key: str, value: Any, ttl_s: int | None = None) -> None: ...
    def delete(self, key: str) -> None: ...
    def list_prefix(self, prefix: str) -> Iterator[str]: ...        # keys under a prefix
    def snapshot(self, key: str, value: Any) -> None: ...           # append-only step snapshot
    def scoped(self, tenant: str) -> "ScopedStore": ...             # hand consumers a safe handle

# Consumers receive a ScopedStore so they CANNOT forget the tenant prefix.
@runtime_checkable
class ScopedStore(Protocol):
    tenant: str
    def get(self, rest: str) -> Any | None: ...     # rest = "{session}/{run}/{kind}/{id}"
    def set(self, rest: str, value: Any, ttl_s: int | None = None) -> None: ...
    def list_prefix(self, rest: str) -> Iterator[str]: ...
    def snapshot(self, rest: str, value: Any) -> None: ...
```

## Frozen key scheme

```
{tenant}/{session}/{run}/{kind}/{id}
# examples:
acme/sess_42/run_7/checkpoint/step_3      # per-step snapshot (resume/fork)
acme/sess_42/cache/{tool_hash}            # tool-result cache, shared across runs in a session
acme/_held/run_7                          # epic-02 held run, tenant-scoped
_system/versions/{worker}@{ver}           # epic-08 registry: cross-tenant, reserved prefix
_system/workers/{id}                      # epic-09 worker registry
```

- **Tenant is always segment 1** → `list_prefix("acme/")` can never cross tenants. Isolation is
  structural, not enforced at the query layer.
- Single-tenant default: `tenant = "default"`. Cross-tenant registries live under `_system/`.
- `cache` key = `tool + args(+ model where the tool's result depends on it)` → resolves the
  cache-key-stability open question: model is part of the key only for model-dependent tools.

## Adapters (behind the one protocol)
`sqlite` (default, single-box, zero-dep) · `files` · `redis` · `postgres`. Selected by
`worker.yaml` `state.backend`. Sticky routing (resolves open question): **shared-store is the v1
default** (any replica rehydrates from the store); affinity-by-session is an optimization the fleet
router (epic 09 stage 4) can add later — shared-store keeps replicas swappable per ADR-0011's
spirit while enabling resume/fork.

## Snapshot granularity (resolves open question)
**Full working-context snapshot per step** for v1 (simple, correct); deltas are a later
optimization. Harness-specific state is serialized via the binding (epic 01 `OWN` mode only —
`WRAP` harnesses get session/cache state but **not** checkpoint/resume, per the C1 matrix).

## File-by-file
- **new** `airlock_agent/state/{store.py (protocol), sqlite.py, files.py, redis.py, postgres.py,
  keys.py (key builder + `scoped`)}`.
- **edit** engine `loop.py` (epic 01) — call `store.snapshot(...)` after each step on `OWN`
  bindings; add `resume(run_id)` / `fork(run_id, at_step, change)` entry points.
- **edit** `surface.py` — resolve `tenant` (default until epic 10) + `X-Airlock-Session`, build the
  `ScopedStore`, pass it into the run.
- **schema** — `state` / `sessions` / `cache` blocks in `worker.schema.json` (epic 07, C2).

## Verification → test layers
- **L2:** kill→resume completes without re-running a cached tool; fork@N diverges only after N;
  session sharing within TTL; new session blind. **Isolation test:** tenant B cannot
  `list_prefix` into tenant A's keys.
- **L1:** key builder always emits `{tenant}/…`; `scoped()` rejects empty tenant; send/pay/write
  tool never written to `cache/`.
- Checkpoint/resume/fork tests run on **`OWN` harnesses only** (C1 matrix); session+cache tests run
  on all.
