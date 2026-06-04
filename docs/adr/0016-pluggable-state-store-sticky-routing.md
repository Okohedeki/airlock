# Pluggable state store + sticky routing

> **Status (2026-06-03): Accepted.** Redesign [epic 04](../redesign/plans/04-state-checkpoint-resume-replay-fork.md). Supersedes [ADR-0011](./0011-scaling-on-cloudflare-named-tunnel-replicas.md); revisits [ADR-0010](./0010-per-call-agent-isolation.md).

airlock gains a **pluggable State Store** — a substrate behind run snapshots,
sessions, the tool-result cache, and per-tenant state. The default is SQLite/files
(zero-dependency, single-box); Redis/Postgres are adapters for scale. Because runs
now carry durable per-step state, the **Fleet Router does sticky routing**: a run's
resume/fork requests land on the worker (or shared store) that holds its snapshots.

This reverses [ADR-0011](./0011-scaling-on-cloudflare-named-tunnel-replicas.md),
which made replicas deliberately **stateless** and relied on Cloudflare named-tunnel
connector replicas for scale. Stateless-by-design is incompatible with
checkpoint/resume, replay, fork, and cross-run tool-result reuse — the core of
[epic 04](../redesign/plans/04-state-checkpoint-resume-replay-fork.md).

## Considered Options

- **Stay stateless; push all state to the client (rejected).** Simplest to scale,
  but makes resume/replay/fork and per-tenant isolation impossible inside airlock —
  it would push the differentiator onto every operator to rebuild.
- **One hard-wired store (e.g. Postgres only) (rejected).** Removes the
  zero-dependency single-box story that the Docker-first packaging
  ([ADR-0012](./0012-docker-first-runtime-model-external.md)) depends on.
- **Pluggable store, SQLite/files default + sticky routing (accepted).** Works on
  one box out of the box, scales by swapping the adapter, and the router's sticky
  routing keeps affinity for stateful runs.

## Consequences

- Replay re-runs model calls live but **re-feeds recorded tool results** — no
  side-effecting tool is re-executed (locked in epic 04).
- Side-effecting tools are never cached; the tool-result cache is opt-in per tool,
  keyed per tenant.
- Sticky-routing mechanism (affinity vs. shared store as the v1 default) is an open
  question in epic 04.

## Consequences — tenant-first key namespace (2026-06-04)

The Store protocol (`get` / `set` / `delete` / `list-by-prefix` / `snapshot`) is
frozen so the SQLite/files/Redis/Postgres adapters all plug in behind one interface.
All keys use a **tenant-first hierarchical scheme**:

```
{tenant}/{session}/{run}/{kind}/{id}
```

Tenant is **always** the first segment, so isolation is *structural*:
`list-by-prefix {tenant}/` can never cross tenants, and the single-tenant default is
just `tenant = "default"`. Genuinely cross-tenant registries (version registry,
worker registry) live under a reserved `_system/` prefix. The protocol exposes a
**`scoped(tenant)`** method that hands every consumer (epics 02 held-runs, 05 traces,
10 per-tenant limits) a pre-scoped handle, so a caller cannot forget the prefix and
leak across the isolation boundary. This makes the relationship **Tenant ⊃ Session ⊃
Run** concrete in the keyspace rather than enforced ad hoc at the query layer.
