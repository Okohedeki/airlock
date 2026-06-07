<h1 align="center">airlock</h1>

<p align="center"><strong>The in-the-loop agent runtime.</strong><br/>Run any agent as a real service — and control every step from inside the loop.</p>

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
  <a href="./docs/cli.md">CLI</a>
</p>

---

A gateway sits *in front* of an agent and proxies its traffic. **airlock runs *inside* the loop** — it executes the agent step by step, so you control every step, tool call, and dollar *as the run happens*. Take an agent built in **LangGraph, smolagents, CrewAI, the OpenAI Agents SDK, or the Claude Agent SDK**, declare it in one `worker.yaml`, and ship it behind an OpenAI-compatible URL. Self-hosted; the model stays yours.

## Features

### 🔁 Control the loop

The differentiator — only possible from inside the run, not from a gateway in front of it.

- **Operate any step** — pause, retry, resume, or kill at a specific step, not just the whole request.
- **Loop guards** — cap max steps, catch runaway loops, and enforce the token/cost budget *during* the run, stopping it before it overshoots instead of billing you after.
- **Mid-run approval** — hold a step for human sign-off before a sensitive tool fires (send, pay, write), inject guidance, then continue.
- **Per-step tool gating** — allow or deny a tool call from its actual arguments at the moment it runs (block the `DELETE`, not just the endpoint).
- **Mid-run routing** — send a heavy reasoning step to a big model and a cheap classification step to a small one, inside one run.
- **Mid-run fallback** — a tool or model fails at step 3? Swap to a backup and continue instead of failing the whole request.
- **Checkpoint & resume** — snapshot state at each step; resume a failed run from the last good step instead of re-paying for the whole thing.
- **Replay & fork** — re-run a past run deterministically, or fork it from step N with one thing changed.
- **Tool-result reuse** — cache an expensive tool call and reuse it across runs, not just whole-response caching.
- **Sandboxed execution** — every tool and code call runs isolated, so a bad or hijacked tool can't touch the host.
- **Live step streaming & per-step cost** — watch each reasoning step and tool call as it happens, with exact cost and latency per step.

### 🧩 Compose the worker

- **One `worker.yaml` manifest** — declarative and version-controlled; the worker is a file, not a pile of glue code.
- **Built from parts** — bind the harness, tools, skills, and model in config; toggle skills on and off.
- **Variants & profiles** — ship the same worker in several configurations from one manifest.
- **Canary + instant rollback** — roll a new version out to a slice of traffic, then promote or revert in one command.

### 🚀 Deploy & expose

- **One command to ship** — `airlock build` produces a reproducible Docker image; `airlock deploy --replicas N` runs a multi-container fleet behind the router.
- **Internal = external** — flip the same worker from an internal service to a public URL with identical controls, no rewrite.
- **Multi-tenant** — authenticate each caller, isolate state per tenant, and track usage from the same worker.
- **Triggers** — fire on a signed webhook, not only on a direct call.
- **Agentic sharding** — route across many worker variants behind one endpoint by capability, cost, or latency.

### 📐 Shape the contract

- **Controlled input** — guard and validate inbound requests, rejecting junk or injection before the loop spends a token.
- **Controlled output** — enforce a schema, format, and redaction contract on every call so downstream code can trust the shape.

### 📊 Observe

- **Live step stream** over SSE, **per-step `cost_usd`**, and Prometheus **`/metrics`**.
- **Operator Console** at `/console` — overview, live runs, traces, approvals, and controls in a local web UI.

## Quickstart

```bash
npm i -g @airlockhq/cli

airlock init my-agent --detect   # detect harness + entrypoint
airlock migrate                  # scaffold worker.yaml
export OPENAI_API_BASE=http://localhost:8080/v1   # your model (local gguf or remote)
airlock up                       # run locally + public URL + /console
#   ✓ live at https://<name>.trycloudflare.com
```

Any OpenAI client can call it — the agent runs its full native loop and returns the result:

```bash
curl -s https://<name>.trycloudflare.com/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"what is 23 times 19?"}]}'
# → {"choices":[{"message":{"role":"assistant","content":"437"}}], ...}
```

Ship to production:

```bash
airlock build                          # reproducible Docker image
airlock deploy --replicas 3 --canary   # multi-container fleet + canary slice
airlock promote | rollback             # canary → 100%, or instant revert
```

For a stable URL on your own domain: `airlock tunnel provision` then `airlock up --durable --hostname agent.example.com` ([durable hosting](./docs/durable-hosting.md)).

## Harnesses

All five run as **OWN** bindings — airlock extracts the framework's tools and prompt and drives the loop itself, so every harness gets full step-control. `airlock init --detect` picks the harness and entrypoint from your deps — no adapter to write.

`langgraph` · `smolagents` · `crewai` · `openai-agents` · `claude` — see [`examples/`](./examples/).

## You own the model

airlock **never hosts inference** — a local gguf/vLLM or a remote `OPENAI_API_BASE`, your endpoint and your keys. airlock makes the calls and runs the loop. [`.env.example`](./.env.example) lists every variable it reads.

## Docs

| | |
| --- | --- |
| [Product brief](./docs/redesign/PRODUCT-BRIEF.md) | The vision and who it's for. |
| [CLI reference](./docs/cli.md) | Every command and flag. |
| [`airlock-config`](https://github.com/Okohedeki/airlock-config) | Optional buyer-facing descriptor served at `/.well-known`. |

## License

[Apache-2.0](./LICENSE)
