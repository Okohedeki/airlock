# READ FIRST — understanding the airlock redesign

The reading map for the next phase (plan + build **all** epics 01–13 together). Ordered
so you build understanding top-down, then drill into the code each epic touches. Every
path below is real.

> **The 5-file fast path** (minimum to grok the whole thing): [`../../MEMORY.md`](../../MEMORY.md)
> → [`./README.md`](./README.md) → [`./plans/01-airlock-loop-engine.md`](./plans/01-airlock-loop-engine.md)
> → [`../../python/agent-runtime/src/airlock_agent/adapter.py`](../../python/agent-runtime/src/airlock_agent/adapter.py)
> → [`../adr/0014-airlock-owns-the-loop.md`](../adr/0014-airlock-owns-the-loop.md). That's the
> spine: the plan, the keystone spec, the code it inverts, and the decision that justifies it.

## Tier 0 — Orient (read first, ~15 min)

| File | Why |
|---|---|
| [`../../MEMORY.md`](../../MEMORY.md) | Engineer's working memory: current state, the all-at-once directive, epic graph, what's shipped. **Start here.** |
| [`./README.md`](./README.md) | The index: vision, locked decisions, the 14-epic table, dependency graph, execution strategy. |
| [`./PRODUCT-BRIEF.md`](./PRODUCT-BRIEF.md) | The authoritative north star — the feature set and the two buyer personas the epics serve. |

## Tier 1 — The actual plans (the program of record)

[`./plans/`](./plans/) `00–13` — the 14 epic specs. Each has Context / Scope / Dependencies /
Design / Key files / Open questions / Verification. For the planning pass these *are* the source.

- **Read [`01-airlock-loop-engine.md`](./plans/01-airlock-loop-engine.md) first** — the keystone;
  everything in "control the loop" (02/03/04/05/06/13) depends on it.
- Then [`07-worker-manifest-and-composition.md`](./plans/07-worker-manifest-and-composition.md)
  (the `worker.yaml` schema everything references) and
  [`09-deploy-expose-and-fleet-router.md`](./plans/09-deploy-expose-and-fleet-router.md) (the second spine).
- [`00-foundations-strip-crypto-config-reset.md`](./plans/00-foundations-strip-crypto-config-reset.md)
  is **done** — read only to see what's already cleared.

## Tier 2 — Decisions & language (the "why" and the vocabulary)

| File | Why |
|---|---|
| [`../../CONTEXT.md`](../../CONTEXT.md) | Glossary in runtime vocab — Worker, Loop Engine, StepEvent/ControlSignal, Operator, Fleet Router, Tenant, State Store. Use these terms exactly. |
| [`../adr/0014-airlock-owns-the-loop.md`](../adr/0014-airlock-owns-the-loop.md) … [`0019`](../adr/0019-inference-stays-external.md) | The six reversals that define the redesign: owns-the-loop, worker.yaml manifest, pluggable state+sticky routing, fleet router, pluggable auth/multi-tenancy, inference-stays-external. |
| [`../adr/0007-harness-adapter-interface.md`](../adr/0007-harness-adapter-interface.md), [`0008`](../adr/0008-airlock-never-hosts-inference.md), [`0010`](../adr/0010-per-call-agent-isolation.md), [`0011`](../adr/0011-scaling-on-cloudflare-named-tunnel-replicas.md) | The *superseded* ADRs — read the status markers to see what changed and why. |

## Tier 3 — The code the epics build on (so plans are grounded in reality)

The part most people skip and shouldn't — the plans modify *this* code.

**The keystone surface (Epic 01 inverts it):**
- [`adapter.py`](../../python/agent-runtime/src/airlock_agent/adapter.py) — the current
  `HarnessAdapter` contract (`run(messages)→AgentRunResult`). Epic 01 replaces it with
  planner/tools/prompt seams.
- [`harnesses/`](../../python/agent-runtime/src/airlock_agent/harnesses/) — the 6 drivers
  (smolagents, langgraph, crewai, openai_agents, claude, custom). Epic 01 rewrites each to expose
  tools+planner instead of running the native loop.
- [`surface.py`](../../python/agent-runtime/src/airlock_agent/surface.py) — the FastAPI
  `/v1/chat/completions` surface + streaming + gate wiring. Epics 01/05/13 touch this.
- [`loader.py`](../../python/agent-runtime/src/airlock_agent/loader.py) — resolves `module:attr`
  entrypoints (epics 01/07).

**Supporting runtime:** [`concurrency.py`](../../python/agent-runtime/src/airlock_agent/concurrency.py)
(BoundedGate — epic 10 extends per-tenant), [`wellknown.py`](../../python/agent-runtime/src/airlock_agent/wellknown.py)
(`/.well-known` serving — epics 07/13), [`config.py`](../../python/agent-runtime/src/airlock_agent/config.py)
+ [`__main__.py`](../../python/agent-runtime/src/airlock_agent/__main__.py) /
[`serve.py`](../../python/agent-runtime/src/airlock_agent/serve.py) (boot path — epic 07 swaps to worker.yaml).

**CLI / manifest / deploy:**
- [`config-file.ts`](../../packages/cli/src/config-file.ts) — today's `.airlock/config.toml`
  loader; **epic 07 supersedes it** with the worker.yaml loader.
- [`migrate.ts`](../../packages/cli/src/migrate.ts) — the stub from epic 00; epic 07 fills in the real schema.
- [`cli.ts`](../../packages/cli/src/cli.ts), [`commands/up.ts`](../../packages/cli/src/commands/up.ts),
  [`tunnel.ts`](../../packages/cli/src/tunnel.ts), [`exec.ts`](../../packages/cli/src/exec.ts) — the
  command + tunnel surface epic 09 reworks into the Docker image + fleet router + expose.

**Dashboard / observability (Epic 05):** [`db.ts`](../../packages/server/src/db.ts),
[`server.ts`](../../packages/server/src/server.ts), [`pages.ts`](../../packages/server/src/pages.ts)
— the inspect store + `/api/inspect` (reporting is dormant; epic 05 re-homes it and adds step
traces/metrics).

## Tier 4 — How we'll verify

[`../testing-e2e.md`](../testing-e2e.md) — the layered test suite + which scenarios Claude+subagents
can automate. The planning pass should add a verification hook per epic that maps to these layers.

---

## Epic → keystone files (quick index for the build-out)

| Epic | Read the spec | Then these files |
|---|---|---|
| 01 Loop engine | `plans/01` | `adapter.py`, `harnesses/*`, `surface.py`, `loader.py`, ADR-0014 |
| 02 Guards/approval | `plans/02` | `surface.py` (engine seam from 01), state store (04) |
| 03 Routing/fallback | `plans/03` | engine model-binding (01/07) |
| 04 State/checkpoint | `plans/04` | new `state/`, engine snapshot hooks, ADR-0016 |
| 05 Observability | `plans/05` | `surface.py`, `packages/server/src/*`, trace store (04) |
| 06 Sandbox | `plans/06` | engine tool-dispatch (01), Dockerfile |
| 07 Manifest | `plans/07` | `config-file.ts`, `migrate.ts`, `config.py`, `__main__.py`, ADR-0015 |
| 08 Versioning | `plans/08` | fleet router (09), state-store version registry (04) |
| 09 Deploy/router | `plans/09` | `up.ts`, `tunnel.ts`, `exec.ts`, new `router/`, Dockerfile, ADR-0017 |
| 10 Multi-tenancy | `plans/10` | `concurrency.py`, new `auth/`, state keys (04), ADR-0018 |
| 11 Triggers | `plans/11` | new `triggers/`, router wiring (09) |
| 12 Sharding | `plans/12` | router variant logic (09) |
| 13 Contract shaping | `plans/13` | new `io/`, `wellknown.py`, `surface.py`, airlock-config schemas |
