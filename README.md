<img alt="airlock" src="assets/logo.svg" width="300">

<p>
  <i>Run any AI agent as a real, self-hosted service — and control every step it takes.</i>
</p>

You built an agent. It works in a notebook. Putting it in front of real callers is the hard part: it loops on its own, spends real money, calls tools that send and delete things, and when a run goes wrong you can't see why or step in.

airlock takes the agent you already built and runs it as an HTTP service on your own hardware or cloud. It doesn't sit *in front of* the agent forwarding traffic — it **drives the agent's loop itself**, so it can cap the spend, hold a risky action for a human, route or retry a single step, and record every move, *as the run happens* rather than after the bill arrives.

Works with [LangGraph](https://github.com/langchain-ai/langgraph), [CrewAI](https://github.com/crewAIInc/crewAI), [smolagents](https://github.com/huggingface/smolagents), the [OpenAI Agents SDK](https://github.com/openai/openai-agents-python), the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-python), or your own code — no adapter to write.

Self-hosted. You keep the model, the keys, and the data — airlock never hosts inference and never sees your traffic.

---

Pick what you are interested in:

<details id="quickstart">
<summary>
<h2>Quickstart</h2>
</summary>

The fastest path needs only Docker. It builds the Python runtime and the dashboard and starts both:

```bash
docker compose up --build
#   worker    → http://localhost:3000   (/console, /v1/chat/completions, /skills/*, /metrics, /healthz)
#   dashboard → http://localhost:8787   (optional web UI; GitHub login needs OAuth env vars)
```

The worker ships with a no-model demo, so it runs out of the box. Open `http://localhost:3000/console` to watch a run step by step.

Call it over plain HTTP — the agent runs its full loop and returns the result:

```bash
curl -s http://localhost:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"what is 23 times 19?"}]}'
# → {"choices":[{"message":{"role":"assistant","content":"437"}}], ...}
```

To run **your** agent with the CLI:

```bash
npm i -g @airlockhq/cli
airlock init my-agent --detect   # detect your framework + entrypoint
# write a worker.yaml (see examples/), then:
airlock up                       # run locally, open a public URL, serve /console
#   ✓ live at https://<name>.trycloudflare.com
```

</details>

Only Docker required — the worker comes up with a demo agent and the operator console, no toolchain to install.

<details id="manifest">
<summary>
<h2>The worker manifest</h2>
</summary>

A worker is **one file**. `worker.yaml` declares what the agent is and every control around it — version-controlled, not a pile of glue code:

```yaml
worker:
  name: support-agent
harness: langgraph                 # any supported harness — airlock drives the loop the same way
entrypoint: agent:build_agent

models:
  default: { endpoint: "http://localhost:11434/v1/chat/completions", model: qwen2.5 }

controls:
  max_steps: 12
  budget: { usd: 0.50 }            # stop the run before it overspends — not after
  tool_gates:
    - tool: shell                  # deny a tool by its actual arguments, at call time
      when: { cmd: { contains: "rm -rf" } }
      action: deny
  approvals:
    - tool: send_email             # hold for a human, then approve / edit / deny

io:
  input_guards:
    - { max_chars: 8000 }          # reject oversized or injection-shaped input first
  output:
    redact: [email, api_key]       # never leak these on the way out

state:
  backend: sqlite                  # persists runs, traces, sessions, tool-result cache

expose: public                     # flip to `internal` for a private service
auth: { scheme: api_key, required: true }
```

Every block is optional except `worker` and `harness`. The CLI validates the manifest against one schema before anything runs; the runtime loads and trusts it.

Source: [`examples/live-demo/worker.yaml`](./examples/live-demo/worker.yaml) exercises every block.

</details>

One version-controlled file declares the agent and every guard around it — no glue code.

<details id="control-the-loop">
<summary>
<h2>Control the loop</h2>
</summary>

Because airlock runs the loop instead of proxying it, these all act *during* a run — the part a service sitting in front of the agent never sees:

- **Budget stops.** Cap tokens or dollars; the run halts before it overshoots.
- **Step cap.** A hard limit on loop iterations, so a runaway can't spin forever.
- **Tool gates.** Allow or deny a tool from its actual arguments at the moment it fires.
- **Mid-run approval.** Hold a sensitive tool (send, pay, write) for a human — approve, edit the args, override the result, or deny.
- **Model routing.** Send a heavy step to a big model and a cheap step to a small one, within one run.
- **Fallback.** A model or tool fails at step 3? Retry, then swap to a backup and continue instead of failing the whole request.
- **Resume & fork.** Checkpoint every step; resume a failed run from the last good one, or fork it from step N with one thing changed. Recorded tool results replay, so side-effecting tools never fire twice.
- **Tool-result cache.** Reuse an expensive read across runs; send/pay/write/delete/post/email are never cached.
- **Resource-limited tool isolation.** Run a tool in a subprocess with CPU, memory, and wall-clock limits (POSIX; best-effort on macOS).
- **Input & output contract.** Reject junk or injection-shaped input before a token is spent; enforce JSON shape and redact secrets on the way out.
- **Live step trace.** Every model call, tool call, and result is streamed and recorded with per-step tokens, cost, and latency.

Source: [`python/agent-runtime/src/airlock_agent/engine/`](./python/agent-runtime/src/airlock_agent/engine/).

</details>

Everything a service in front of the agent structurally can't do, because it requires running the loop rather than watching the traffic.

<details id="http-surface">
<summary>
<h2>HTTP surface</h2>
</summary>

A running worker is far more than a chat endpoint:

| Endpoint | What it does |
| --- | --- |
| `POST /v1/chat/completions` | Run the agent and return the result. `"stream": true` adds live `event: step` SSE frames as the run happens. |
| `POST /skills/{id}` | Call one declared skill directly, typed — unknown → 404, disabled → 403. |
| `POST /hooks/{path}` | Start a run from a **signed webhook** (HMAC-SHA256), declared in `triggers.webhook`. |
| `GET /v1/runs/held` · `POST /v1/runs/{id}/decision` | The **approval queue** — list held runs, then approve / edit / override / deny. |
| `POST /v1/runs/{id}/resume` · `/fork` | Resume from the last checkpoint, or fork from a step. |
| `GET /v1/runs` · `/v1/runs/{id}` · `/v1/manifest` | Run index, full step trace, and the active config. |
| `GET /metrics` | Live concurrency / queue stats (JSON or Prometheus). |
| `GET /console` | The **operator console** — a static, no-build web UI (Overview, Live, Runs, Approvals, Controls). |
| `GET /.well-known/airlock-config.yaml` | Optional discovery descriptor, so other agents can find what this worker offers. |

Source: [`python/agent-runtime/src/airlock_agent/surface.py`](./python/agent-runtime/src/airlock_agent/surface.py).

</details>

Chat is one door — typed skills, signed webhooks, an approval queue, resume/fork, traces, and an operator console come with it.

<details id="harnesses">
<summary>
<h2>Works with any harness</h2>
</summary>

It doesn't matter what you built your agent in — airlock is harness-agnostic. Control is **feature-derived**: where airlock can drive the model calls it **owns** the loop and the full control set applies; an opaque entrypoint it can only observe is **terminal**.

`stub` · `openai` · `langgraph` · `smolagents` · `crewai` · `openai-agents` · `claude` · `custom`

For the five frameworks — plus `openai` (a raw OpenAI-compatible endpoint) and `stub` (a deterministic test binding) — airlock **extracts the agent's tools and drives the loop itself** rather than running the framework's own loop, so the full control set applies. The one exception: a plain `custom` callable is opaque, so it's **terminal** (airlock sees the final result, no mid-run control) — implement the `Planner` protocol or expose tools to get full control. There's no adapter to write: `airlock init --detect` reads your dependencies and entrypoint and picks the harness.

Source: [`examples/`](./examples/) — one runnable worker per framework, plus the full-feature `live-demo`.

</details>

Harness-agnostic: whatever you built the agent in runs the same — and gets the full control set wherever airlock can own the loop.

<details id="deploy">
<summary>
<h2>Deploy &amp; expose</h2>
</summary>

```bash
airlock build                    # reproducible, content-addressed Docker image
airlock up --docker              # run the image locally + a public URL + /console
airlock up --durable --hostname agent.example.com   # stable URL on your own domain
airlock deploy --replicas 3 --canary img@10         # local fleet behind a router, 10% canary
airlock promote | rollback       # promote the canary to 100%, or revert
```

`airlock up` runs the worker on your hardware (native or `--docker`) and opens a Cloudflare tunnel — an ephemeral `*.trycloudflare.com` URL by default, or your own domain with `--durable` (you bring the Cloudflare connector token; airlock holds no keys of yours). `airlock deploy` runs N containers behind a local request-routing proxy with canary and instant rollback. Flip `expose: internal` ↔ `public` to serve the same worker as a private internal service or an internet-facing one — same controls, no rewrite.

Source: [durable hosting](./docs/durable-hosting.md).

</details>

Run it locally, expose it on your own domain, or fan out a local fleet — same worker, same controls, no rewrite.

<details id="cli">
<summary>
<h2>CLI</h2>
</summary>

```
airlock init <name> --detect    # detect framework + entrypoint, scaffold a worker
airlock up [--docker] [--durable --hostname H]   # run + public URL + /console
airlock build                   # reproducible, content-addressed Docker image
airlock deploy --replicas N [--canary img@pct]   # local fleet behind a router
airlock promote | rollback      # canary → 100%, or instant revert
airlock doctor                  # validate worker.yaml + environment
airlock tunnel provision --hostname H            # zero-touch Cloudflare tunnel on your domain
airlock login | whoami | sync   # optional dashboard auth + project registration
```

Source: [`docs/cli.md`](./docs/cli.md) — every command and flag.

</details>

The full command surface for scaffolding, running, and shipping a worker.

---

## You own the model

airlock **never hosts inference.** Point a model binding at a local server (llama.cpp / vLLM) or any remote model endpoint it can call — your endpoint, your keys. airlock makes the calls and runs the loop; nothing leaves your box. [`.env.example`](./.env.example) lists every variable it reads.

## Repository layout

- `python/agent-runtime` — the runtime: loop engine, harness bindings, controls, state, triggers, and the HTTP surface.
- `packages/cli` — `@airlockhq/cli`: scaffolding, validation, run, and deploy + the fleet router.
- `packages/server` — the optional dashboard (GitHub login, multi-project call ledger), port `8787`.
- `examples/` — one runnable worker per framework, plus the full-feature `live-demo`.
- `docs/` — [CLI reference](./docs/cli.md), [durable hosting](./docs/durable-hosting.md), and more.

## License

[Apache-2.0](./LICENSE) — the runtime, the CLI, and the router are open and self-hostable.
