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
  <a href="./docs/cli.md">CLI</a> ·
  <a href="./docs/adr/">Decisions</a>
</p>

---

A gateway sits *in front* of an agent and proxies its traffic. **airlock runs *inside* the loop** — it executes the agent step by step, so you control every step, tool call, and dollar *as the run happens*. Take an agent built in **LangGraph, smolagents, CrewAI, the OpenAI Agents SDK, or the Claude Agent SDK**, declare it in one `worker.yaml`, and ship it behind an OpenAI-compatible URL. Self-hosted; the model stays yours.

## Control the loop

- **Operate any step** — pause, retry, resume, or kill at a specific step, not just the whole request.
- **Loop guards** — cap steps and enforce the token/cost budget *during* the run, before it overshoots.
- **Mid-run approval** — hold a step for human sign-off before a sensitive tool fires, then continue.
- **Per-step tool gating** — allow or deny a call from its actual arguments (block the `DELETE`, not the endpoint).
- **Routing & fallback** — heavy step to a big model, cheap step to a small one; swap a failed tool/model and continue.
- **Checkpoint, resume & fork** — resume a failed run from the last good step, or fork a past run from step N.
- **Sandboxed execution** — every tool and code call runs isolated from the host.
- **Live streaming & per-step cost** — watch each step and tool call as it happens, with cost and latency per step.

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

## More

- **Compose** — one `worker.yaml` binds harness, tools, skills, and model, with variants and per-skill toggles.
- **Deploy & expose** — flip the same worker from internal service to public URL, no rewrite; multi-tenant with per-caller auth, isolated state, and usage; fires on signed webhooks.
- **Shape the contract** — validate inbound requests; enforce an output schema + redaction so downstream code can trust the shape.
- **Observe** — SSE step stream, per-step `cost_usd`, Prometheus `/metrics`, and an Operator Console at `/console`.

## Harnesses

All five run as **OWN** bindings — airlock extracts the framework's tools and prompt and drives the loop itself, so every harness gets full step-control. `airlock init --detect` picks the harness and entrypoint from your deps — no adapter to write.

`langgraph` · `smolagents` · `crewai` · `openai-agents` · `claude` — see [`examples/`](./examples/).

## You own the model

airlock **never hosts inference** ([ADR-0019](./docs/adr/0019-inference-stays-external.md)) — a local gguf/vLLM or a remote `OPENAI_API_BASE`, your endpoint and your keys. airlock makes the calls and runs the loop. [`.env.example`](./.env.example) lists every variable it reads.

## Docs

| | |
| --- | --- |
| [Product brief](./docs/redesign/PRODUCT-BRIEF.md) | The vision and who it's for. |
| [CLI reference](./docs/cli.md) | Every command and flag. |
| [Decisions](./docs/adr/) | ADRs — 0014–0020 record the runtime architecture. |
| [`airlock-config`](https://github.com/Okohedeki/airlock-config) | Optional buyer-facing descriptor served at `/.well-known`. |

## License

[Apache-2.0](./LICENSE)
