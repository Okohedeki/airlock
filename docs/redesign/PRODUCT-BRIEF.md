# airlock — Product Brief

**Run your agent as a real service — and operate it from inside the loop.**

Gateways and internal developer platforms sit *in front* of an agent and proxy its traffic: auth, rate limits, routing, logging at the boundary. They see a request go in and a response come out, and nothing in between. airlock runs *inside* the loop. It executes the agent step by step, so you control every step, every tool call, and every dollar as the run happens — harness-agnostic, and the same runtime whether the agent is an internal service other systems call or a worker exposed to the internet.

That is the line no one sitting in front of the agent can copy.

---

## Who it's for

### Primary — the platform / infrastructure team

Agents multiply inside the org: the data team's analysis agent, support's triage agent, eng's code-review agent, a dozen internal copilots — each built by a different team in a different framework. They start calling each other. They fall over under cross-team load. Every team rebuilds the same plumbing (an API wrapper, retries, a state table, a queue), and the platform team is left supporting a zoo of heterogeneous, brittle agents.

The platform team's job is to hand every team a **paved road**: one consistent way to ship an agent as a controllable internal service — a single manifest, an instant internal endpoint, with queue, state, routing, and backpressure already handled — that the team which built the agent **operates itself**, and that can be exposed externally later without a rewrite.

This is the buyer to win:

- Real budget, and a mandate to standardize tooling across many teams.
- Sticky and low-churn — once agents ship on the paved road, they stay.
- Already structured for it: most software orgs now run a dedicated platform team that treats the internal platform as a product, with developers as its customers.

**The framing that decides whether this wins or dies: *who the control serves.*** The incumbents (AI-gateway and IDP vendors) sell a central control plane — RBAC, policy enforcement, cost governance — control handed to the org to impose on its developers. That is a cage developers route around, sold into a long enterprise fight. airlock sells the same capabilities — queue, state, routing, step-level control — as a **golden path the building team wants for itself**: "operate your agent like the service it already is." A gift teams adopt bottom-up, not a policy dropped on them from above.

Why airlock specifically, and not a generic IDP:

- **It runs inside the loop** — the gateway/IDP crowd governs traffic at the boundary; airlock operates the agent step by step.
- **Harness-agnostic** — works no matter which framework each team chose.
- **Self-hosted** — runs on the org's own infrastructure, which is the only option for data-sensitive and regulated teams whose data cannot leave the perimeter.
- **Internal = external** — the same worker that serves other internal services can be exposed to the internet with identical controls, no rebuild.

Don't try to be a better Backstage. Be the agent-runtime layer that plugs into the platform they already run, and gives the team that built the agent the operational control the gateways only sell upward.

### Secondary — expose an agent to the internet

AI-native startups and product teams shipping an agent *as* their product, plus solo builders putting an agent they own online. They hit the pilot-to-production cliff: the agent works in a demo, but customers need it to behave like a dependable service — structured output their code can trust, fallback so it doesn't 500, resume so a failed run doesn't cost twice, rollback when a release misbehaves. They don't want to rebuild the agent into "real" infrastructure or hand a platform a cut of every call.

airlock wraps the agent they already built — no rewrite — and gives them that production envelope as config, self-hosted, with no per-call tax. The key property is shared with the internal case: an agent built to run internally becomes a customer-facing product by flipping its exposure, not by rebuilding it.

(Hobbyists are the top of the funnel here, not the revenue — the developers who try airlock on a home server are the ones who later bring it onto the platform at work.)

---

## Features

The differentiator fronts the list. Everything in the first group is something a front-of-agent gateway structurally cannot do, because it requires running inside the agent's loop rather than proxying its traffic.

### Control the loop — only possible from inside the run

- **Operate any step** — pause, retry, resume, or kill at a specific step, not just the whole request.
- **Loop guards** — cap max steps, catch runaway loops, and enforce the token/cost budget *during* the run, stopping it before it overshoots instead of billing you after.
- **Mid-run intervention** — hold a step for human approval before a sensitive tool fires (send, pay, write), inject guidance, then continue.
- **Per-step tool gating** — allow or deny a tool call based on its actual arguments at the moment it runs (block the `DELETE`, not just the endpoint).
- **Mid-run model routing** — heavy reasoning step to a big model, cheap classification step to a small one, inside a single run.
- **Mid-run fallback** — a tool or model fails at step 3, swap to a backup and continue instead of failing the whole request.
- **Checkpoint & resume** — snapshot working state at each step; resume a failed run from the last good step instead of re-paying for the whole thing.
- **Replay & fork** — re-run any past run deterministically, or fork it from step N with one thing changed.
- **Tool-result reuse** — cache an expensive tool call and reuse it across runs, not just whole-response caching.
- **Sandboxed execution** — every tool and code call runs isolated, so a bad or hijacked tool can't touch the host.
- **Live step streaming** — stream each reasoning step and tool call as it happens, not just the final tokens.
- **Per-step cost & latency** — see exactly which step and which tool spent the time and money.

### Compose the worker

- **A worker, not an output** — you ship something that does a job, not a URL that just answers.
- **Built from parts** — skills, hooks, MCP servers, tools, model binding, toggled in config.
- **One YAML manifest** — declarative, version-controlled; the worker is a file.
- **Harness-agnostic** — same manifest over LangGraph, CrewAI, smolagents, or the Claude SDK.
- **Releasable in pieces** — flip a skill, swap an MCP, roll out a hook, no rewrite.
- **Versioned with canary + instant rollback** — ship to a slice of traffic, compare, promote or roll back in one command.

### Deploy & expose

- **One command to ship** — `airlock deploy worker.yaml` → live worker, on your own hardware.
- **Internal service** — other services and other agents call it over a stable internal interface; this is the agent-as-microservice.
- **Expose to the internet** — flip the same worker to a public URL with identical controls, no rebuild; internal and external are one deployment.
- **Customer identification** — authenticate each caller, isolate state and enforce limits per customer, and track usage — multi-tenant from the same worker.
- **Scheduled & event-triggered** — fires on a cron, webhook, or event, not only when someone calls it.
- **Agentic sharding** — many worker variants behind one endpoint, routed by capability, cost, or latency, load-balanced across the fleet.

### Shape the contract

- **Controlled input** — guard and validate inbound requests, rejecting junk or injection before the loop spends a token.
- **Controlled output** — enforce a schema, format, and redaction contract on every call so downstream code can trust the shape.

### State

- **State tracking** — session and run state held across steps and across calls, so the worker doesn't start blind every time.

---

**The sell, in one line:** a gateway guards the front door and counts who walks through; airlock runs the house — every step, every tool, every dollar, inside the loop — and serves it the same way whether the caller is your own internal service or the open internet. That is *control the loop*, and it is the half no one sitting in front of the agent can copy.
