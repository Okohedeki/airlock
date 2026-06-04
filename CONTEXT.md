# airlock

An **in-the-loop agent runtime**. airlock executes an agent *step by step* so the
Operator controls every step, tool call, and dollar **during** the run —
harness-agnostic, self-hosted, and the **same Worker** whether it serves internal
callers or the open internet. The moat is **control the loop**, which a
front-of-agent gateway structurally cannot copy.

**Open source from day one (Apache-2.0).** The runtime, the CLI shim, and the fleet
router are fully open and self-hostable. Any hosted product is convenience over
self-hosting, not a feature gate.

> The program of record for this product lives in [`docs/redesign/`](./docs/redesign/)
> (`PRODUCT-BRIEF.md` + 14 epics). This glossary tracks that program. Terms from the
> previous product (deploy-orchestrator + x402 payments + two-target Recipes) are
> collected under **Historical (pre-redesign)** at the bottom and are no longer
> current.

## Language

### Core runtime

**Worker**:
The deployable unit airlock runs and controls — a `worker.yaml` manifest plus the
code, skills, and model bindings it composes. The Worker, not a build output, is
what ships; it is released, versioned, and exposed as a whole.
_Avoid_: Agent (informal only — the Worker is the deployable), service, function, app

**Loop Engine**:
The in-Worker orchestrator that **owns the agent loop** — it makes the model calls
and dispatches the tools itself, emitting a `StepEvent` per iteration and consuming
`ControlSignal`s. This is the keystone that makes step-level control possible.
_Avoid_: Driver, scheduler, executor

**Step** / **StepEvent**:
A **Step** is one iteration of the loop (a model call and/or a tool dispatch). A
**StepEvent** is the uniform record the engine emits per step — index, type, input,
output, tokens, duration, status.
_Avoid_: Turn, tick, frame, event (unqualified)

**ControlSignal**:
A directive the loop consumes between steps, from policy or a human Operator:
`continue | pause | retry | kill | override`. The mechanism behind guards,
approval gates, and mid-run intervention.
_Avoid_: Command, action, hook

**Harness**:
The agent framework a Worker is built on — LangGraph, CrewAI, smolagents, OpenAI
Agents, Claude SDK, or a custom loop. Under the redesign the Harness **contributes
tools, a planner, and prompt assembly**; airlock runs the loop. (This reverses the
prior "never inspects internals at runtime" stance — the engine now drives the
framework's pieces directly.)
_Avoid_: Framework (too generic), engine (that's the Loop Engine)

**Skill**:
A callable the Worker exposes — **skills flatten to tools**, and MCP-provided tools
are skills too. The airlock-config descriptor supplies each skill's typed
input/output schema for validation and the typed `/skills/<id>` surface.
_Avoid_: Capability, plugin, function (unqualified)

### Manifest & contract

**worker.yaml**:
The single operational manifest for a Worker — composition (skills, MCP, tools,
model bindings, harness), controls, routing, I/O contract, state, triggers, expose,
tenancy/auth, and the price table. Replaces `.airlock/config.toml`.
_Avoid_: config.toml, deploy config, settings

**airlock-config**:
Narrowed to the **buyer-facing descriptor** of a deployed Worker — what skills it
offers and their I/O schemas. Validated and served at `/.well-known`; it supplies
the skill schemas the contract layer validates against. It is *not* the operational
manifest (that's `worker.yaml`).
_Avoid_: contract config, deploy config

### Actors

**Operator**:
The entity that deploys *and* controls a Worker — owns the hardware, the manifest,
and the runtime controls (guards, approvals, routing, rollback). The canonical
actor of the system.
_Avoid_: Publisher (retired), user (overloaded), owner, developer

**Caller**:
The authenticated party — another agent, app, or human — that invokes a Worker.
_Avoid_: Client, consumer, requester, payer (payments are retired)

**Tenant**:
A per-customer identity derived from caller auth, used to isolate state and
sessions, scope limits, and meter usage. Many Tenants can share one Worker.
_Avoid_: Org, account, customer (use Tenant for the isolation boundary)

### Fleet & deploy

**Fleet Router**:
The component that fronts a fleet of Workers and routes across them —
version/variant/canary routing, agentic sharding, load balancing, and **sticky
routing** for resume/fork. Control stays *inside* each Worker; the router only
decides which Worker handles a request.
_Avoid_: Gateway, proxy, load balancer (it is more than any one of these)

**Variant** / **Version**:
A **Version** is a content-addressed release of a Worker (the unit of canary and
instant rollback). A **Variant** is one of several Worker configs sharing a single
endpoint, selected by capability/cost/latency (agentic sharding). A Version is a
special case of a Variant.
_Avoid_: Revision, build, flavor

**Expose**:
The act of flipping a Worker between internal and public reach. Internal vs
external differs **only** in network binding + auth — same routes, same Worker
(`expose: internal | public` in `worker.yaml`).
_Avoid_: Publish, deploy (that's the verb for shipping), open

**Tunnel**:
The Cloudflare tunnel that `expose: public` opens to give an internal Worker a
public URL. (Narrowed from the prior hosted dev-tunnel business — it is now just the
public-exposure mechanism.)
_Avoid_: Proxy, forwarder

### State & execution

**State Store**:
The pluggable substrate behind run snapshots, sessions, the tool-result cache, and
per-tenant state. SQLite/files by default; Redis/Postgres for scale.
_Avoid_: Database, cache (it is broader), persistence layer

**Session**:
Caller/tenant-scoped run continuity — the thread a series of runs belongs to,
keyed by tenant by default or an explicit `X-Airlock-Session`.
_Avoid_: Conversation, thread (unqualified), context

**Sandbox**:
The isolated execution environment for a single tool or code call — a subprocess
with resource limits (CPU, memory, FD, seccomp) and no host network unless granted
in `worker.yaml`.
_Avoid_: Jail, container (container-per-tool is a later-phase escalation), VM

**Trigger**:
A non-request entry point that invokes a Worker run — cron schedule, webhook, or
event intake. A triggered run goes through the engine like any other, so all
controls, observability, and state apply.
_Avoid_: Cron job, hook, listener

### Operations

**Concurrency cap** *(runtime)*:
The maximum number of in-flight `/v1/chat/completions` runs one Worker executes in
parallel (`AIRLOCK_MAX_CONCURRENCY`). Callers beyond the cap queue (FIFO); callers
beyond the queue bound, or who wait too long, get HTTP 429. Per-Worker, about
simultaneous Callers — distinct from per-Tenant limits.
_Avoid_: Throughput, rate limit (that's request-rate over time), pool size

## Flagged ambiguities

**Worker vs Agent**:
The deployable unit is a **Worker**. "Agent" is fine in informal prose for the AI
behavior a Worker runs, but when naming the thing that is deployed, versioned, and
exposed, say Worker.

**"Deploy"** has two valid uses:
- The verb: shipping a Worker to the Operator's hardware.
- The project: `airlock` is the name of this whole repo.
Context disambiguates.

**"Runtime" is now the correct framing.** airlock *is* an in-the-loop agent runtime:
it owns the loop and holds per-step state and production traffic by design. (This
reverses the previous glossary, which forbade "runtime" and asserted "never holds
production traffic" — both are retired below.)

## Historical (pre-redesign)

These terms described the previous product (a deploy orchestrator monetized via
x402) and are **no longer current**. They are kept only so older commits, ADRs, and
docs remain readable. See [`docs/redesign/`](./docs/redesign/) for what replaced
them.

- **Publisher** → replaced by **Operator**.
- **Caller-as-payer**, **Payment Middleware**, **Facilitator**, **Credit Balance** →
  payments removed entirely (redesign epic 00).
- **Target**, **Recipe**, **Wrangler / target CLI** → replaced by one Docker image +
  the **Fleet Router**; deploy is no longer a matrix of per-Target Recipes.
- **Bundle**, **Handler stub**, **Scaffold** → artifacts of the old Airlock-contract
  build flow; airlock-config is now descriptor-only.
- **dev-free / prod-paid**, **hosted dev tunnel** → the dev/prod paid-tier business
  model is retired; **Tunnel** survives only as the `expose: public` mechanism.
- The **"runtime forbidden"** rule and the **"never holds production traffic"**
  invariant are both reversed (see above).
