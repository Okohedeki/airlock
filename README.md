<h1 align="center">airlock</h1>

<p align="center"><strong>The in-the-loop agent runtime.</strong><br/>Run any agent as a real service — and operate it from inside the loop.</p>

<p align="center">
  <a href="https://github.com/Okohedeki/airlock/releases">
    <img src="https://img.shields.io/github/v/release/Okohedeki/airlock?style=flat&logo=github" alt="Release">
  </a>
  <a href="https://www.npmjs.com/package/@airlockhq/cli">
    <img src="https://img.shields.io/npm/v/@airlockhq/cli?logo=npm" alt="npm">
  </a>
  <a href="https://www.python.org/downloads/">
    <img src="https://img.shields.io/badge/python-3.9%2B-blue?logo=python&logoColor=white" alt="Python 3.9+">
  </a>
  <a href="./LICENSE">
    <img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache-2.0">
  </a>
</p>

<p align="center">
  <a href="./docs/redesign/PRODUCT-BRIEF.md">Product brief</a> ·
  <a href="./examples/">Examples</a> ·
  <a href="./docs/cli.md">CLI</a> ·
  <a href="./docs/adr/">Decisions</a>
</p>

---

Gateways and internal developer platforms sit *in front* of an agent and proxy its traffic — auth, rate limits, routing, logging at the boundary. They see a request go in and a response come out, and nothing in between. **airlock runs *inside* the loop.** It executes the agent step by step, so you control every step, every tool call, and every dollar *as the run happens* — harness-agnostic, self-hosted, and the same worker whether it serves an internal caller or the open internet.

Take an agent built in **LangGraph, smolagents, CrewAI, the OpenAI Agents SDK, or the Claude Agent SDK**, declare it in one `worker.yaml`, and ship it behind an OpenAI-compatible URL. airlock never hosts inference — the model is always yours — it owns the *loop*.

## Control the loop

The differentiator, and the half no front-of-agent gateway can copy, because it requires running inside the agent's loop rather than proxying its traffic:

- **Operate any step** — pause, retry, resume, or kill at a specific step, not just the whole request.
- **Loop guards** — cap max steps, catch runaway loops, and enforce the token/cost budget *during* the run, stopping it before it overshoots instead of billing you after.
- **Mid-run approval** — hold a step for human approval before a sensitive tool fires (send, pay, write), inject guidance, then continue.
- **Per-step tool gating** — allow or deny a tool call from its actual arguments at the moment it runs (block the `DELETE`, not just the endpoint).
- **Mid-run routing & fallback** — heavy step to a big model, cheap step to a small one; a tool or model fails at step 3, swap to a backup and continue.
- **Checkpoint, resume & fork** — snapshot state at each step; resume a failed run from the last good step, or fork a past run from step N with one thing changed.
- **Sandboxed execution** — every tool and code call runs isolated, so a bad or hijacked tool can't touch the host.
- **Live step streaming & per-step cost** — watch each reasoning step and tool call as it happens, with exact cost and latency per step.

## What else it does

**Compose the worker** — one declarative `worker.yaml` manifest binds the harness, tools, skills, and model; variants and per-skill toggles; canary rollout with one-command instant rollback.

**Deploy & expose** — one reproducible Docker image; `airlock deploy --replicas N` runs a multi-container fleet behind a router; flip the same worker from an internal service to a public URL with identical controls, no rewrite. Multi-tenant from the same worker: per-caller auth, isolated state, and usage tracking. Fires on signed webhooks, not only direct calls.

**Shape the contract** — guard and validate inbound requests before the loop spends a token; enforce an output schema and redaction contract so downstream code can trust the shape.

**Observe** — live step stream over SSE, per-step `cost_usd`, Prometheus `/metrics`, and a local **Operator Console** at `/console` (overview, live runs, traces, approvals, controls).

## Quickstart

```bash
# 1. Install the CLI
npm i -g @airlockhq/cli

# 2. Detect your harness and wire it
airlock init my-agent --detect
#   → detected smolagents; wired the entrypoint — confirm or edit

# 3. Generate the worker.yaml manifest
airlock migrate

# 4. Point at your model — a local gguf, or a remote OpenAI-compatible endpoint
export OPENAI_API_BASE=http://localhost:8080/v1     # e.g. llama.cpp / vLLM
#   (model API keys are read by your harness; airlock never holds them)

# 5. Go live — runs the agent locally + opens a public URL
airlock up
#   ✓ live at https://<name>.trycloudflare.com
#   ✓ console at http://localhost:3000/console
```

Any OpenAI client can now call it from anywhere — the agent runs its **full native loop** (decompose → call a tool → observe → re-plan → answer) and returns the result:

```bash
curl -s https://<name>.trycloudflare.com/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"what is 23 times 19?"}]}'
# → {"choices":[{"message":{"role":"assistant","content":"437"}}], ...}
```

Ready for production? Build a pinned image and run a fleet behind the router:

```bash
airlock build                          # reproducible content-hash Docker image
airlock deploy --replicas 3 --canary   # multi-container fleet + canary slice
airlock promote                        # send 100% of traffic to the new version
airlock rollback                       # instant revert — stable wins
```

For a stable URL on **your own** Cloudflare domain, `airlock tunnel provision` auto-creates the tunnel and DNS, then `airlock up --durable --hostname agent.example.com`. See [durable hosting](./docs/durable-hosting.md).

## Supported harnesses

All five run as **OWN** bindings — airlock extracts the framework's tools and prompt and drives the loop itself, so every harness gets full step-control. Verified live against a local Qwen2.5-3B.

| Harness | Framework | Example |
| --- | --- | --- |
| `langgraph` | LangGraph | [`examples/`](./examples/) |
| `smolagents` | Hugging Face smolagents | [`examples/`](./examples/) |
| `crewai` | CrewAI | [`examples/`](./examples/) |
| `openai-agents` | OpenAI Agents SDK | [`examples/`](./examples/) |
| `claude` | Claude Agent SDK | [`examples/`](./examples/) |

`airlock init --detect` reads your deps and imports to pick the harness and locate the entrypoint — no adapter to write.

## CLI

```bash
airlock init <name> --detect    # detect harness + entrypoint, wire the binding
airlock migrate                 # scaffold worker.yaml from the detected config
airlock doctor                  # validate worker.yaml against the schema
airlock build                   # reproducible Docker image for this worker
airlock up [--durable]          # run the worker locally + public URL + /console
airlock deploy --replicas N     # multi-container fleet behind the router
airlock promote | rollback      # canary → 100%, or instant revert
airlock tunnel provision        # auto-create a durable Cloudflare tunnel + DNS
```

See the [full CLI reference](./docs/cli.md).

## You own the model

airlock **never hosts inference** ([ADR-0019](./docs/adr/0019-inference-stays-external.md)). The model is always yours — a local gguf/vLLM on your box, or a remote `OPENAI_API_BASE`. airlock makes the calls and runs the loop; the inference endpoint stays on your infrastructure. A committed [`.env.example`](./.env.example) lists every variable airlock reads, grouped by use case — copy it to `.env` (gitignored) and fill in only what you use.

## Architecture

```
python/agent-runtime    airlock-agent — the runtime
  engine/               loop engine: StepEvent/ControlSignal, planner, resume/fork, per-step cost
  harnesses/            stub + openai + extract.py (all 5 frameworks via tool-extraction)
  state/                pluggable store: memory + sqlite (redis/postgres pluggable)
  surface.py            OpenAI chat + SSE step stream, /skills, approval/resume, triggers, /metrics
  console/              local Operator Console at /console
packages/cli            the `airlock` CLI + worker.schema.json
packages/server         dashboard backend (GitHub OAuth, projects, inspect store)
docs/redesign/          program of record: product brief + 14 epic plans
```

The locked architectural decisions live in [`docs/adr/`](./docs/adr/) — ADRs 0014–0020 record the runtime reframes (airlock owns the loop, `worker.yaml` manifest, pluggable state + sticky routing, fleet router, pluggable auth + multi-tenancy, inference stays external).

## What airlock is — and isn't

**It is:** a runtime that owns the agent's loop and exposes step-level control; a single `worker.yaml` that composes any harness into a deployable worker; a CLI to build, run, and roll out a multi-container fleet; self-hosted on your own hardware.

**It isn't:** a hosted inference runtime ([ADR-0019](./docs/adr/0019-inference-stays-external.md)) or a front-of-agent gateway. airlock operates the (optional) tunnel and the agent loop — never your model, never a cut of every call.

## The airlock ecosystem

| Repo | What it does |
| --- | --- |
| **airlock** (this repo) | The in-the-loop agent runtime — own the loop, compose the worker, deploy the fleet. |
| [**airlock-config**](https://github.com/Okohedeki/airlock-config) | The buyer-facing descriptor: declare an agent's skills, region, and compliance → a static `/.well-known` bundle airlock serves, and the skill schemas it validates I/O against. Optional. |

## Development

```bash
pnpm install && pnpm build && pnpm typecheck && pnpm test   # JS/TS workspace
# Python runtime (pytest): base targets 3.9; framework harnesses need 3.10+
```

Tests: Python 3.9 baseline, Python 3.12 framework harnesses, and the CLI suite — all green, with ruff/typecheck clean. See [`docs/testing-e2e.md`](./docs/testing-e2e.md) for the five-layer strategy.

## License

[Apache-2.0](./LICENSE)
