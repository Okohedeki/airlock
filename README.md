<h1 align="center">airlock</h1>

<p align="center"><strong>Run agent work with approvals and a clear execution record.</strong></p>

<p align="center">
  Run a worker on your machine, review consequential actions,<br/>
  and inspect its execution record through one local console.
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

Airlock owns an agent's execution loop so an operator can inspect tool actions,
approve consequential work, and understand failures. Configure tools and a model
in `worker.yaml`, run locally, and use the OpenAI-compatible API or worker console.
Public access is optional and does not require Cloudflare.

## Architecture

airlock is one runtime with two operator surfaces on top of it:

| Piece | Language / packaging | What it is |
| --- | --- | --- |
| **Worker runtime** | **Python**, shipped as a **Docker image** (`airlock-worker`) | Runs the agent loop and serves the OpenAI-compatible API, `/console`, and `/metrics`. This is the thing that actually runs your agent. |
| **CLI** (`@airlockhq/cli`) | **TypeScript**, published to **npm** | The operator/dev tool: scaffold, validate, build the image, run locally + tunnel, deploy a fleet, open the control plane. |
| **Dashboards** | **TypeScript** (Node) | The `airlock control` plane (fleet operations) and the optional compose `dashboard` (call ledger). |

So "Docker *and* an npm package" isn't a contradiction: the **worker runs as a Docker image**, and the **CLI on npm operates it**. One `worker.yaml` declares each worker.

## Run it — Docker Compose

The fastest path, with only Docker installed. `docker compose up --build worker` builds and starts the worker. Copy `.env.example`
to `.env` and set a long random `AIRLOCK_OPERATOR_TOKEN` to enable console administration:

```bash
docker compose up --build worker
#   worker    → http://localhost:3000   (/healthz, /console, /v1/chat/completions, /metrics)
```

The worker bundles the `live-demo` stub, so it runs with no config. Any OpenAI client can call it:

```bash
curl -s http://localhost:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"what is 23 times 19?"}]}'
# → {"choices":[{"message":{"role":"assistant","content":"437"}}], ...}
```

To run **your** worker, mount its directory over `/app/worker` (or uncomment the volume in `docker-compose.yml`):

```bash
docker run -p 127.0.0.1:3000:3000 --env-file .env -v "$PWD/my-worker:/app/worker" airlock-worker:local
```

Open `http://localhost:3000/console` and enter your operator token. Caller API keys
remain configured separately in `worker.yaml`. An empty operator token disables
administration. State persists in the `worker-state` volume. Set `OPENAI_API_KEY` and `OPENAI_API_BASE` for workers that call a real model.

## Focus of the redesign

Airlock is narrowing to one worker, one manifest, one runtime, and one console:

- **Prepare, then approve:** inspect a proposed tool action before allowing it.
- **Recover interrupted work:** inspect checkpoints and resume with explicit
  handling of side effects. Durable background jobs and restart-safe approval
  recovery are the next milestone; exactly-once external actions are not guaranteed.
- **Serve controlled work:** run a local HTTP API with caller authentication,
  separate operator authorization, limits, and an execution record.

The first foundation is implemented: local startup does not open a tunnel,
operator routes require a separate token, and the console accepts operator and
caller credentials independently. Native startup and Compose host ports default
to loopback.

Fleet orchestration, canaries, organization/SSO management, and advanced routing
are legacy or deferred capabilities. Their existing commands are not the supported
redesigned administration path. Native Windows service packaging, direct HTTPS
setup, and strong Windows tool isolation remain planned work.

See [the redesign contract](./docs/redesign.md) for scope and acceptance criteria.

## Operate it with the CLI

From a worker directory, start locally with the CLI or Python runtime:

```bash
airlock up --python python        # local worker; no public tunnel
# console: http://localhost:3000/console
```

Native Windows source-checkout setup (PowerShell, Python 3.9+):

```powershell
python -m pip install -e ./python/agent-runtime
$env:AIRLOCK_OPERATOR_TOKEN = python -c "import secrets; print(secrets.token_urlsafe(32))"
Set-Location ./examples/live-demo
python -m airlock_agent
```

Keep the generated token available to paste into the local console. Strong Windows
sandboxing is not implemented: a worker with `sandbox.enabled: true` now refuses
tool execution when the required subprocess limits are unavailable. For a trusted
local demonstration only, explicitly set `sandbox.enabled: false` in its manifest.
Container execution is a separate option, not a guarantee of per-tool isolation.

For an explicitly requested legacy tunnel use `airlock up --tunnel`, or
`airlock up --durable --hostname agent.example.com` with your own connector token.
Direct HTTPS hosting can use a separately configured reverse proxy; automated
Windows service installation and HTTPS setup are not implemented yet. Do not
forward the console or operator routes through a public proxy.

Full command reference: [`docs/cli.md`](./docs/cli.md). The fleet `control`, `deploy`,
and rollout commands remain legacy functionality outside the focused redesign.

## Harnesses

These integrations extract tools and, where supported, prompts into Airlock's own loop. They do not preserve arbitrary framework graphs, handoffs, or orchestration. `airlock init --detect` picks the harness and entrypoint from your dependencies, with no adapter to write.

`langgraph` · `smolagents` · `crewai` · `openai-agents` · `claude` — see [`examples/`](./examples/).

## You own the model

airlock never hosts inference. Point it at a local gguf/vLLM or a remote `OPENAI_API_BASE` — your endpoint, your keys. airlock makes the calls and runs the loop. [`.env.example`](./.env.example) lists every variable it reads.

## Docs

| | |
| --- | --- |
| [CLI reference](./docs/cli.md) | Every command and flag. |
| [Harness showcase](./docs/showcase.md) | One real containerized worker per framework, all green. |
| [Durable hosting](./docs/durable-hosting.md) | A stable URL on your own Cloudflare account. |
| [`airlock-config`](https://github.com/Okohedeki/airlock-config) | Optional buyer-facing descriptor served at `/.well-known`. |

## License

[Apache-2.0](./LICENSE)
