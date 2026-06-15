# airlock

An **in-the-loop agent runtime** — airlock executes an agent *step by step* so the Operator
controls every step, tool call, and dollar **during** the run — harness-agnostic, self-hosted
and open (Apache-2.0), the **same Worker** internal or public. The moat is **control the
loop**, which a front-of-agent gateway structurally cannot copy.

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
The in-Worker orchestrator that **owns the agent loop** where it can — it makes the
model calls and dispatches the tools itself, emitting a `StepEvent` per iteration and
consuming `ControlSignal`s. The keystone that makes step-level control possible.
Control is **feature-derived, not uniform** — see **OWN** / **WRAP** / **Terminal** for
which control set each Harness gets and why. _Keystone decision (in force):_ airlock
drives the framework's pieces rather than running the framework's own loop; that is what
makes step-level control possible at all.
_Avoid_: Driver, scheduler, executor; never call a wrapped (tool-gated) loop "owned"

**OWN**:
_(Control mode.)_ airlock drives the model calls **and** tool dispatch itself, so the
**full** control set applies — budget/step caps, model routing + fallback, tool gating +
approval, resume/fork, tool-result cache, sandbox, and the I/O contract. The mode for
`stub`, `openai`, and all five framework harnesses (their tools + prompt are extracted;
airlock runs the loop). _Decision (in force):_ each request builds a **fresh binding**
(per-call isolation) so concurrent runs never share harness state.
_Avoid_: never call a WRAP or Terminal loop "owned"; driver

**WRAP**:
_(Control mode.)_ airlock wraps a Harness's own loop and can intercept **only** at the
tool-dispatch seam — so only tool-centric control applies (gating, approval,
tool-fallback, tool-result cache, sandbox), **not** model routing or per-step model
control. The seam exists in the engine; the only WRAP binding that ships today is a plain
`custom` callable, which is opaque and so collapses to **Terminal**.
_Avoid_: owned (only OWN is owned); proxy, passthrough

**Terminal**:
_(Control mode — the degenerate WRAP case.)_ When the wrapped code is opaque — a plain
`custom` callable that runs its own logic and exposes no interceptable tool dispatch —
airlock can only **observe the final result**, with no mid-run control. The `custom`
Harness's mode unless its entrypoint implements the
`Planner` protocol (→ OWN) or exposes extractable tools.
_Avoid_: don't imply a Terminal Harness gets guards, approval, or routing

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
The value of the `harness:` key — the binding that supplies a Worker's loop pieces. The
canonical set is **eight** — five **framework adapters** (`langgraph`, `smolagents`,
`crewai`, `openai-agents`, `claude`); two **built-in bindings** (`openai` — airlock's own
loop over a raw OpenAI-compatible endpoint, no framework; `stub` — a deterministic,
test-only binding); and `custom` (your own callable, or a `Planner`). The Harness
**contributes tools, a planner, and prompt assembly**; airlock runs the loop. Which
control set a Harness gets depends on its mode — see **OWN** / **WRAP** / **Terminal**.
_Avoid_: Framework (the set is broader than frameworks); engine (that's the Loop Engine);
any name outside the eight (there is no `hermes`, `openai-compatible`, etc.)

**Skill**:
A callable the Worker exposes — **skills flatten to tools**, and MCP-provided tools
are skills too. The airlock-config descriptor supplies each skill's typed
input/output schema for validation and the typed `/skills/<id>` surface. A Skill is
**enabled or disabled** (`skills.<id>.enabled` in `worker.yaml`); disabling it drops its
tool from the loop AND returns 403 from `/skills/<id>` (an unknown id → 404).
_Avoid_: Capability, plugin, function (unqualified)

**Model routing**:
Choosing which model binding serves a given model call (OWN harnesses only). What ships
today: a per-Worker default (`routing.default`), **whole-run** switching via the
`X-Airlock-Variant` header (a Variant overlay), and model **fallback** (retry, then a
backup binding). _Decision (committed, currently unwired):_ **per-step** routing — a heavy
step to a big model and a cheap step to a small one within one run — is driven by
**role-by-tool** — `routing.roles` maps a tool to a role, the engine tags the model step
bound to that tool, and `by_role` selects the binding. Resolution precedence is locked
(explicit tag > step type > tool); until a role is populated in code, per-step routing is
a **known gap**.
_Avoid_: Fleet Router (that routes across Workers); load balancing; sharding

### Manifest & contract

**worker.yaml**:
The single operational manifest for a Worker — composition (skills, MCP, tools,
model bindings, harness), controls, routing, I/O contract, state, triggers, expose,
tenancy/auth, and the price table. Replaces `.airlock/config.toml`. _Decision (in
force):_ the runtime boots from `worker.yaml` alone (a frozen loader contract) and trusts
the CLI-validated manifest.
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
sessions, scope limits, and meter usage. Many Tenants can share one Worker. _Decision (in
force):_ caller auth resolves the Tenant, the structural isolation boundary for all state
(`{tenant}/…` keys).
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
per-tenant state. SQLite/files by default; Redis/Postgres for scale. _Decision (in
force):_ a frozen, pluggable contract — backends swap without touching the engine.
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

**Control plane** *(runtime override)*:
The operator surface for changing a **running** Worker's behavior **without rewriting
`worker.yaml`** — toggle a Skill on/off, switch the model **Variant**/binding, adjust guards
(step/budget caps, approvals) live. Served at `/v1/control[/*]` and driven from `/console`.
_Decision (in force):_ overrides are **ephemeral and layered** — `worker.yaml` stays the frozen,
CLI-validated source of truth and the **loader contract is unchanged** (boot still reads the
manifest alone); a restart reverts to it. This does **not** contradict the frozen-manifest rule:
boot is frozen; live *operation* is controllable, and each override is reported as a delta from
the manifest.
_Avoid_: editing the manifest at runtime (overrides never persist to `worker.yaml`); calling it a
config reload

**Control Plane (dashboard)** *(enterprise console)*:
The fleet-wide operations console — the `airlock control` web app — for governing many Workers
across **Environments** and **Tenants**: fleet health/observability, the **Runs** explorer,
the **Approvals** queue, cost/usage, versioning/exposure, and **Access control**. It composes
the per-Worker runtime surfaces (`/v1/control`, `/v1/runs`, `/metrics`, approvals) into a
fleet view; control actions proxy to the owning Worker. _Decision (in force):_ the dashboard is
the **Operator's** surface; it owns no agent state — it aggregates and proxies.
_Avoid_: confusing it with the per-Worker `/console`; calling it the runtime.

**Environment**:
A deployment stage a Worker belongs to — **prod / staging / dev** — used to scope the dashboard
and gate change control (e.g. prod requires 2-person approval). _Status:_ **representative today**
(the runtime is single-stage); a real multi-environment backend is a planned feature.
_Avoid_: conflating with **Variant** (a config overlay) or **Version** (a release).

**Role / RBAC**:
The permission set a dashboard user holds — Owner / Operator / Approver / Auditor / Viewer —
resolved (with SSO) to authorize operator actions. _Status:_ **representative today**; real
RBAC/SSO enforcement is a planned backend feature.
_Avoid_: confusing a Role (dashboard user permission) with a **Tenant** (a Caller identity).

**Audit log**:
The immutable record of every privileged action — control change, approval decision, version
promote/rollback, exposure flip — with actor, target, environment, and time. _Status:_ live
control-plane actions are recorded in-process; durable/seeded history is **representative** until
a persistent audit store ships.
_Avoid_: confusing with the per-run **StepEvent** trace (that records the agent loop, not operator actions).

## Relationships

Cardinality and boundaries between the core terms (the seams the redesign must keep clean):

- **Operator** `1 — *` **Worker** — one Operator runs many Workers.
- **Worker** `1 — *` **Tenant** — many Tenants share one Worker; the Tenant is the
  isolation boundary, not the Worker.
- **Tenant** `⊃` **Session** `⊃` **Run** — state nests this way. The State Store keys
  it literally: `{tenant}/{session}/{run}/{kind}/{id}`, tenant always first so
  isolation is structural. Cross-tenant registries live under `_system/`.
- **Harness** *contributes* tools + planner + prompt assembly → the **Loop Engine**
  *runs* them. The Harness no longer runs its own loop (where airlock can own it).
- **Skill** `=` **Tool** — a Skill flattens to a callable; MCP-provided tools are
  Skills too. The **airlock-config** descriptor supplies a Skill's typed I/O schema;
  the **worker.yaml** manifest wires it into the running Worker. One Worker has both
  documents: `worker.yaml` (operational) and an airlock-config descriptor (buyer-facing).
- **Variant** `⊃` **Version** — a Version is a content-addressed release; a Variant is
  any of several configs behind one endpoint. A Version is a special case of a Variant.
- **Fleet Router** *decides* which Worker handles a request; the **Tunnel** *exposes* a
  Worker to the public internet. The router routes; the tunnel only opens a public URL.
  Distinct concerns — never conflate them.

## Flagged ambiguities

**Worker vs Agent**:
The deployable unit is a **Worker**. "Agent" is fine in informal prose for the AI
behavior a Worker runs, but when naming the thing that is deployed, versioned, and
exposed, say Worker.

**"Deploy"** has two valid uses:
- The verb: shipping a Worker to the Operator's hardware.
- The project: `airlock` is the name of this whole repo.
Context disambiguates.

**"Gateway"**:
Colloquial "gateway to the web" means a Worker's **public reach** — that is **Expose** +
**Tunnel** (`expose: public` opens a Cloudflare **Tunnel** to a real public URL), *not* a new
concept. Avoid "gateway" as a noun for an airlock component: it is the word for the
**front-of-agent** competitor the moat contrasts against ("a front-of-agent gateway
structurally cannot copy" controlling the loop), and **Fleet Router** already lists
`_Avoid_: Gateway`. When you mean "reachable on the public internet," say **Expose** / public
**Tunnel**.

**"Runtime" is now the correct framing.** airlock *is* an in-the-loop agent runtime:
it owns the loop and holds per-step state and production traffic by design. (This
reverses the previous glossary, which forbade "runtime" and asserted "never holds
production traffic" — both are retired below.)

## Example dialogue

**Dev:** "Does the `crewai` Harness get the same controls as `custom`?"
**Domain expert:** "No — that's the **feature-derived** rule. `crewai` runs **OWN**: airlock
extracts its tools and drives the loop, so the full control set applies (routing, approval,
budget). A plain `custom` callable is **Terminal** — airlock only sees the final result, so no
guards, no approval, no routing. To get full control on `custom`, implement the `Planner`
protocol or expose extractable tools (→ OWN)."

**Dev:** "I set `routing.by_role` to send summarize-steps to a cheap model, but it never
switches."
**Domain expert:** "Right — **per-step routing** (Model routing) is committed but **currently
unwired**: nothing populates a step's role, so `by_role` can't fire. What ships today is
whole-run switching via `X-Airlock-Variant` and model **fallback**. The planned trigger is
**role-by-tool** (`routing.roles`)."

## Historical (pre-redesign)

These terms described the previous product (a deploy orchestrator monetized via
x402) and are **no longer current**. They are kept only so older commits and
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
