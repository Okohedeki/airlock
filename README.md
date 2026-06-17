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
  <a href="#operate-it-with-the-cli">CLI</a> ·
  <a href="#operate--govern-from-the-ui">Control plane</a> ·
  <a href="./examples/">Examples</a>
</p>

---

Point airlock at an agent you built in **LangGraph, smolagents, CrewAI, the OpenAI Agents SDK, or the Claude Agent SDK**, declare it in one `worker.yaml`, and get back an OpenAI-compatible URL anyone can call. It runs self-hosted, and the model stays yours.

The difference is where airlock sits. Most gateways sit *in front of* an agent and proxy its traffic — they see the request and the response, nothing in between. airlock runs the loop **itself**, one step at a time, so it can act on any step *while the run is still happening*: gate a tool call from its real arguments, hold it for a human, swap the model on failure, stop on a budget, snapshot and fork.

## Architecture

airlock is **one runtime** with operator tooling on top of it. "A Docker image *and* an npm package" isn't a contradiction — the worker **runs as a Docker image**, and the npm CLI **operates it**.

| Piece | Language / packaging | What it is |
| --- | --- | --- |
| **Worker runtime** | **Python**, shipped as a **Docker image** | Owns the agent loop and serves the HTTP surface: OpenAI-compatible `/v1/chat/completions` (with SSE step streaming), run control (`/v1/runs/*`, `/v1/control/*`), `/console`, `/metrics`, `/healthz`. This is the thing that actually runs your agent. |
| **CLI** (`@airlockhq/cli`) | **TypeScript**, npm *(not yet published — run from source, see below)* | The operator/dev tool: scaffold, validate, build the image, run locally + tunnel, deploy a fleet, open the control plane. |
| **Control plane** | **TypeScript** (Node) | `airlock control` — a local web app on `:8788` that operates every worker in a workspace (start/stop as containers, skills, models, runs, approvals, RBAC, audit). |
| **Compose dashboard** | **TypeScript** (Node) | Optional `:8787` GitHub-login call ledger / project registry that ships with the Docker Compose stack. Distinct from the control plane. |

One `worker.yaml` declares each worker; the runtime reads it and the CLI validates it against a single JSON schema.

## Run it — Docker Compose

The fastest path, with only Docker installed. `docker compose up --build` builds the Python runtime and Node dashboard inside the images and starts both:

```bash
docker compose up --build
#   worker    → http://localhost:3000   (/healthz, /console, /v1/chat/completions, /metrics)
#   dashboard → http://localhost:8787   (optional; GitHub login needs the OAuth env vars)
```

The worker bundles the `live-demo` stub, so it runs with **no model and no config**. The stub just echoes — it proves the loop, the API, and the controls work end to end before you wire a model:

```bash
curl -s http://localhost:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"what is 23 times 19?"}]}'
# → {"model":"live-demo","choices":[{"message":{"role":"assistant","content":"echo: what is 23 times 19?"}}], ...}
```

To get a **real answer**, point the worker at a model — see [Bring a model](#bring-a-model). To run **your** worker, mount its directory over `/app/worker` (or uncomment the volume in `docker-compose.yml`):

```bash
docker run -p 3000:3000 -v "$PWD/my-worker:/app/worker" airlock-worker:local
```

State persists in named volumes (`worker-state`, `dashboard-data`). Set `OPENAI_API_KEY` / `OPENAI_API_BASE` for workers that call a real model.

## Features

Each bullet below is backed by real runtime code; the honest gaps are called out as **(not yet)**.

### 🔁 Control the loop

Running the loop yourself is what unlocks the rest. Because airlock drives the steps, it exposes them over HTTP (`/v1/runs/*`, `/v1/control/*`) and acts between them.

- **Operate any step** — pause, resume, or kill a run at a step (`POST /v1/runs/{id}/resume`), not the whole request.
- **Loop guards** — cap max steps and enforce a **token / USD budget** *during* the run, so it stops before it overshoots instead of billing you after.
- **Mid-run approval** — hold a step for human sign-off before a sensitive tool fires; approve, deny, edit, or override via `POST /v1/runs/{id}/decision`, then continue. Auto-denies on a timeout window.
- **Per-step tool gating** — allow or deny a tool call from its **real arguments** at the moment it runs. Inspect the `DELETE` payload, not only the route.
- **Mid-run routing** — send a heavy reasoning step to a big model and a cheap step to a small one, inside one run (per-step or per-role).
- **Mid-run fallback** — when a model or tool fails at step 3, retry then swap to a backup and continue instead of failing the whole request.
- **Checkpoint, resume & fork** — snapshot state at each step; resume a failed run from the last good step, or **fork** it from step N with one thing changed (`POST /v1/runs/{id}/fork`), replaying recorded results up to the divergence.
- **Tool-result reuse** — cache an expensive tool call per session and reuse it; never-cache is enforced for `send`/`pay`/`write`/`delete`.
- **Sandboxed execution** — run a tool in a subprocess under CPU / memory / wall-clock limits, so a hijacked tool can't reach the host.
- **Live step streaming & per-step cost** — stream each step over SSE with `cost_usd` on every model step.

### 🧩 Compose the worker

- **One `worker.yaml` manifest** — declarative and version-controlled; the worker is a file, not a pile of glue code. Validated against one JSON schema (the CLI validates, the runtime trusts).
- **Built from parts** — bind the harness, tools, skills, and models in config; toggle skills on and off.
- **Variants & profiles** — deep-merge overlays on the base manifest, selected per request (`X-Airlock-Variant`) or at deploy (`--profile`).

### 🚀 Deploy & expose

- **Reproducible image** — `airlock build` generates a per-project Docker image (`FROM` the airlock base, `COPY` your code, `pip install` your `requirements.txt`) tagged by a content hash, so the same manifest yields the same image.
- **Multi-container fleet** — `airlock deploy --replicas N` runs N detached worker containers behind a router with **`--canary <image>@<pct>`**; `airlock promote` / `rollback` shift the canary to 100% or revert (router endpoints, default `:8080`).
- **Internal ↔ public** — `expose:` in the manifest is a declared flag; a worker becomes publicly reachable when you front it with the **Cloudflare tunnel** (`airlock up`, or `deploy --expose`) — same worker, same controls, no rewrite.
- **Multi-tenant** — authenticate each caller (API-key scheme) and **isolate state per tenant**; per-step `cost_usd` is metered for every run.
- **Triggers** — fire on an **HMAC-signed webhook** (`POST /hooks/{path}`), not only on a direct call. *(Cron triggers: not yet.)*

### 📐 Shape the contract

- **Controlled input** — reject junk or prompt-injection patterns (and over-long input) before the loop spends a token.
- **Controlled output** — enforce a JSON schema/format and a redaction contract (email, SSN, card, API-key patterns) on every response.

### 🎛️ Operate & govern from the UI

`airlock control` opens a **fleet control plane** at `http://localhost:8788` — operate every worker from one dashboard, no file-editing required. (Distinct from the compose `dashboard` on `:8787`.) Sections: **Overview · Workers · Models · Detect · Runs · Approvals · Tenants · Cost & usage · Audit log · Access control.**

- **Workers** — every `worker.yaml` in your workspace with live status, model, skills, runs, errors, and cost. **Start** runs each worker **as a Docker container** (building its image on first start), so the host needs only Docker — no Python runtime or per-harness installs. (`--python` opts into legacy host mode.) Open a worker for tabs: **Skills, Models, Controls, Exposure, Config (raw `worker.yaml` editor, schema-validated), Logs.**
- **Skills on/off** — toggle any skill; the change is written to `worker.yaml` (comment-preserving) and applied **live** to a running worker.
- **Models** — view each worker's model bindings and **set them up** (model, endpoint, API-key env var) or switch the default — written back to `worker.yaml`.
- **Runs & approvals** — a fleet-wide run explorer, and a governance queue to **approve / deny** held tool calls, proxied to each worker's live control surface.
- **Detect** — point it at a folder; it identifies the harness, entrypoint, and tools.
- **Governance (real & persistent)** — RBAC roles enforced server-side, environments with change-control, and an append-only **audit log** on disk (every privileged action recorded). *(SSO is a config screen; federated IdP login is not yet wired — sign-in is local identity selection.)*

> Rollout/canary appears in the worker drawer's **Versions** tab as a representative view; the working mechanism is the CLI/router (`airlock deploy --canary`, `promote`, `rollback`).

### 📊 Observe

- **Live step stream** over SSE (`stream: true`), **per-step `cost_usd`**, and **`/metrics`** (concurrency stats; Prometheus text with `Accept: prometheus`).
- **Operator Console** at `/console` on every running worker.
- **Run traces** persisted to the state store and queryable at `/v1/runs` and `/v1/runs/{id}`.

## Operate it with the CLI

The CLI is the operator/dev tool on top of the runtime — scaffold a worker, run it locally behind a public URL, open the control plane, or ship a fleet.

```bash
npm i -g @airlockhq/cli           # once published

# until then, run it from this repo:
#   pnpm -r build && npm link -w @airlockhq/cli    (or: node packages/cli/dist/cli.js <cmd>)

airlock init my-agent --detect ./src/agent   # declare the harness folder + its areas (harness/entrypoint/tools)
airlock migrate                              # scaffold worker.yaml (with a model slot to confirm)
airlock build                                # reproducible image (skip with `airlock up --docker --mount` for no-build dev)
airlock up --docker                          # run that image locally + public Cloudflare URL + /console
#   ✓ live at https://<name>.trycloudflare.com
#   (drop --docker for the host-Python fast path; --docker runs the exact image you ship)

airlock control                              # operate the whole fleet from one dashboard (runs workers in Docker)
#   ▸ http://localhost:8788
```

Ship a fleet:

```bash
airlock build                          # reproducible, content-addressed Docker image
airlock deploy --replicas 3 --canary <image>@10   # N worker containers + a canary slice, behind the router
airlock promote --version <ver>        # canary → 100%
airlock rollback                       # instant revert to stable
```

Other commands: `doctor` (validate config), `status`, `logs`, `secret`, `dev` (tunnel an already-running worker), `login`/`whoami`/`sync` (optional backend), `tunnel provision` (durable hosting). For a stable URL on your own domain: `airlock tunnel provision`, then `airlock up --durable --hostname agent.example.com` ([durable hosting](./docs/durable-hosting.md)). Full reference: [`docs/cli.md`](./docs/cli.md).

## Harnesses

All five run as **OWN** bindings: airlock **extracts the framework's tools** and drives the loop with its own planner, so every harness gets full step-control — no adapter to write. `airlock init --detect` picks the harness, entrypoint, and tools from your project.

`langgraph` · `smolagents` · `crewai` · `openai-agents` · `claude` — see [`examples/`](./examples/) for one runnable worker per framework.

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
#   the `[m-primary]` prefix is the binding airlock chose — change routing in worker.yaml to see it switch.
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
