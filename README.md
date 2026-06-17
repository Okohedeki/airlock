<h1 align="center">airlock</h1>

<p align="center"><strong>Run any AI agent as a controlled, self-hosted HTTP service.</strong></p>

<p align="center">
  Point it at a LangGraph, smolagents, CrewAI, OpenAI Agents, or Claude agent;<br/>
  get an OpenAI-compatible URL, and control every step, tool call, and dollar from inside the loop.
</p>

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
  <a href="#run-it--docker-compose">Run it</a> ·
  <a href="./examples/">Examples</a> ·
  <a href="./docs/cli.md">CLI</a>
</p>

---

Point airlock at an agent you built in **LangGraph, smolagents, CrewAI, the OpenAI Agents SDK, or the Claude Agent SDK**, declare it in one `worker.yaml`, and get back an OpenAI-compatible URL anyone can call. It runs self-hosted, and the model stays yours.

The difference is where airlock sits. Most gateways sit in front of an agent and proxy its traffic. airlock runs the loop itself, one step at a time, so you can act on any step while the run is still happening.

## Architecture

airlock is one runtime with two operator surfaces on top of it:

| Piece | Language / packaging | What it is |
| --- | --- | --- |
| **Worker runtime** | **Python**, shipped as a **Docker image** (`airlock-worker`) | Runs the agent loop and serves the OpenAI-compatible API, `/console`, and `/metrics`. This is the thing that actually runs your agent. |
| **CLI** (`@airlockhq/cli`) | **TypeScript**, published to **npm** | The operator/dev tool: scaffold, validate, build the image, run locally + tunnel, deploy a fleet, open the control plane. |
| **Dashboards** | **TypeScript** (Node) | The `airlock control` plane (fleet operations) and the optional compose `dashboard` (call ledger). |

So "Docker *and* an npm package" isn't a contradiction: the **worker runs as a Docker image**, and the **CLI on npm operates it**. One `worker.yaml` declares each worker.

## Run it — Docker Compose

The fastest path, with only Docker installed. `docker compose up --build` builds the Python runtime and Node dashboard inside the images and starts both:

```bash
docker compose up --build
#   worker    → http://localhost:3000   (/healthz, /console, /v1/chat/completions, /metrics)
#   dashboard → http://localhost:8787   (optional; GitHub login needs the OAuth env vars)
```

The worker bundles the `live-demo` stub, so it runs with **no model and no config**. The stub
just echoes — it proves the loop, the API, and the controls work end to end before you wire a model:

```bash
curl -s http://localhost:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"what is 23 times 19?"}]}'
# → {"model":"live-demo","choices":[{"message":{"role":"assistant","content":"echo: what is 23 times 19?"}}], ...}
```

To get a **real answer**, point the worker at a model — see [Bring a model](#bring-a-model) below.

To run **your** worker, mount its directory over `/app/worker` (or uncomment the volume in `docker-compose.yml`):

```bash
docker run -p 3000:3000 -v "$PWD/my-worker:/app/worker" airlock-worker:local
```

State persists in named volumes (`worker-state`, `dashboard-data`). Set `OPENAI_API_KEY` and `OPENAI_API_BASE` for workers that call a real model.

## Features

### 🔁 Control the loop

Running the loop yourself is what unlocks the rest. A gateway in front of the agent can read the request and the response, and nothing in between.

- **Operate any step** — pause, retry, resume, or kill at a specific step, not the whole request.
- **Loop guards** — cap max steps, catch runaway loops, and enforce the token and cost budget during the run, so it stops before it overshoots rather than billing you after.
- **Mid-run approval** — hold a step for human sign-off before a sensitive tool fires (send, pay, write), inject guidance, then continue.
- **Per-step tool gating** — allow or deny a tool call from its real arguments at the moment it runs. Inspect the `DELETE` payload, not only the route.
- **Mid-run routing** — send a heavy reasoning step to a big model and a cheap classification step to a small one, inside one run.
- **Mid-run fallback** — when a tool or model fails at step 3, swap to a backup and continue instead of failing the whole request.
- **Checkpoint & resume** — snapshot state at each step, then resume a failed run from the last good step instead of re-paying for the whole thing.
- **Replay & fork** — re-run a past run deterministically, or fork it from step N with one thing changed.
- **Tool-result reuse** — cache an expensive tool call and reuse the result across runs, below the level of whole-response caching.
- **Sandboxed execution** — every tool and code call runs isolated, so a hijacked tool can't reach the host.
- **Live step streaming & per-step cost** — watch each reasoning step and tool call as it happens, with exact cost and latency on every step.

### 🧩 Compose the worker

- **One `worker.yaml` manifest** — declarative and version-controlled. The worker is a file, not a pile of glue code.
- **Built from parts** — bind the harness, tools, skills, and model in config; toggle skills on and off.
- **Variants & profiles** — ship the same worker in several configurations from one manifest.
- **Canary + instant rollback** — roll a new version out to a slice of traffic, then promote or revert in one command.

### 🚀 Deploy & expose

- **One command to ship** — `airlock build` produces a reproducible Docker image; `airlock deploy --replicas N` runs a multi-container fleet behind the router.
- **Internal or external, same worker** — flip an internal service to a public URL with identical controls and no rewrite.
- **Multi-tenant** — authenticate each caller, isolate state per tenant, and track usage from the same worker.
- **Triggers** — fire on a signed webhook, not only on a direct call.
- **Agentic sharding** — route across many worker variants behind one endpoint by capability, cost, or latency.

### 📐 Shape the contract

- **Controlled input** — validate inbound requests and reject junk or injection before the loop spends a token.
- **Controlled output** — enforce a schema, format, and redaction contract on every call so downstream code can trust the shape.

### 🎛️ Operate & govern from the UI

`airlock control` opens a **fleet control plane** at `http://localhost:8788` — operate every worker from one dashboard, no file-editing required. (This is distinct from the compose `dashboard` on :8787, which is the GitHub-login call ledger / project registry.)

- **Fleet dashboard** — every `worker.yaml` in your workspace with live status, model, skills, runs, errors, and cost; **start and stop** workers in place. Start runs each worker **as a Docker container** (building its image on first start), so the host needs only Docker — no Python runtime or per-harness installs. (`--python` opts into legacy host mode.)
- **Models** — view each worker's model bindings and **set them up** (model, endpoint, API-key env var) or switch the default.
- **Skills on/off** — toggle any skill; the change is written to `worker.yaml` (running or stopped) and applied **live** to a running worker.
- **Runs & approvals** — a fleet-wide run explorer with step timelines, and a governance queue to **approve, deny, or hold** tool calls.
- **Detect** — point it at a project and it identifies the harness + entrypoint.
- **Governance** — RBAC roles, environments with change-control, an append-only **audit log**, and per-tenant **cost & usage**.

### 📊 Observe

- **Live step stream** over SSE, **per-step `cost_usd`**, and Prometheus **`/metrics`**.
- **Operator Console** at `/console` on every running worker — overview, live runs, traces, approvals, and controls.

## Operate it with the CLI

The CLI (`@airlockhq/cli`, npm) is the operator/dev tool on top of the runtime — scaffold a worker, run it locally behind a public URL, open the control plane, or ship a fleet:

```bash
npm i -g @airlockhq/cli           # once published

# until then, run it from this repo:
#   pnpm -r build && npm link -w @airlockhq/cli   (or: node packages/cli/dist/cli.js <cmd>)

airlock init my-agent --detect ./src/agent   # declare the harness folder + its areas
airlock migrate                  # scaffold worker.yaml (with a model slot to confirm)
export OPENAI_API_BASE=http://localhost:8080/v1   # your model (local gguf or remote)
airlock up --docker              # run the worker image locally + public Cloudflare URL + /console
#   ✓ live at https://<name>.trycloudflare.com
#   (drop --docker for the host-Python fast path; --docker runs the exact image you ship)

airlock control                  # operate the whole fleet from one dashboard
#   ▸ http://localhost:8788
```

Ship to production:

```bash
airlock build                          # reproducible Docker image
airlock deploy --replicas 3 --canary   # multi-container fleet + canary slice
airlock promote | rollback             # canary → 100%, or instant revert
```

For a stable URL on your own domain: `airlock tunnel provision`, then `airlock up --durable --hostname agent.example.com` ([durable hosting](./docs/durable-hosting.md)). Full command reference: [`docs/cli.md`](./docs/cli.md).

## Harnesses

All five run as **OWN** bindings: airlock extracts the framework's tools and prompt and drives the loop itself, so every harness gets full step-control. `airlock init --detect` picks the harness and entrypoint from your dependencies, with no adapter to write.

`langgraph` · `smolagents` · `crewai` · `openai-agents` · `claude` — see [`examples/`](./examples/).

## Bring a model

airlock never hosts inference. Point it at a local gguf/vLLM or a remote `OPENAI_API_BASE` — your endpoint, your keys. airlock makes the calls and runs the loop. [`.env.example`](./.env.example) lists every variable it reads.

**Declare it.** Point `--detect` at the folder your harness lives in. It declares the harness and its areas — entrypoint and tools — for you to confirm. It does **not** guess a model (your endpoint + keys aren't in the code):

```text
$ airlock init my-agent --detect ./src/agent
declared from folder ./src/agent (confirm or edit .airlock/config.toml [agent]):
  • harness: claude (dependency)
  • entrypoint: agent:build_options (factory in src/agent/agent.py)
  • tools: multiply, danger
```

**Confirm the model.** `airlock migrate` writes `worker.yaml` with a model **slot** — the place we show what we found, for you to fill in. airlock owns the loop and calls this endpoint:

```yaml
# worker.yaml — confirm what we found.
models:
  default:
    endpoint: ""   # ← your OpenAI-compatible endpoint (local gguf/vLLM or remote), or set OPENAI_API_BASE
    model: ""      # ← model id to request
```

Then run — the worker calls the model and drives the loop (`docker compose up --build`, or `airlock up --docker`).

**See which model answered.** A bundled mock model echoes the binding it routed to, so model routing and fallback are visible end to end:

```bash
docker compose --profile epic03 up -d --build
curl -s http://localhost:3001/v1/chat/completions \
  -H 'content-type: application/json' -d '{"messages":[{"role":"user","content":"hello"}]}'
# → {"model":"live-openai","choices":[{"message":{"content":"[m-primary] hello"}}], ...}
#   the `[m-primary]` prefix is the model binding airlock chose — change routing in worker.yaml to see it switch.
```

## Docs

| | |
| --- | --- |
| [CLI reference](./docs/cli.md) | Every command and flag. |
| [Harness showcase](./docs/showcase.md) | One real containerized worker per framework, all green. |
| [Durable hosting](./docs/durable-hosting.md) | A stable URL on your own Cloudflare account. |
| [`airlock-config`](https://github.com/Okohedeki/airlock-config) | Optional buyer-facing descriptor served at `/.well-known`. |

## License

[Apache-2.0](./LICENSE)
