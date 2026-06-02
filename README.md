<h1 align="center">airlock</h1>

<p align="center">
  <a href="https://github.com/Okohedeki/airlock/stargazers">
    <img src="https://img.shields.io/github/stars/Okohedeki/airlock?style=flat&logo=github" alt="GitHub stars">
  </a>
  <a href="https://github.com/Okohedeki/airlock/releases">
    <img src="https://img.shields.io/github/v/release/Okohedeki/airlock?style=flat&logo=github&include_prereleases" alt="GitHub release">
  </a>
  <a href="https://github.com/Okohedeki/airlock/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License">
  </a>
  <a href="https://www.npmjs.com/package/@airlockhq/cli">
    <img src="https://img.shields.io/npm/v/@airlockhq/cli?logo=npm" alt="npm">
  </a>
</p>

<p align="center"><strong>Run any AI agent behind a paid, OpenAI-compatible URL — on your own hardware.</strong> Take an agent built in any framework, expose it at <code>POST /v1/chat/completions</code> with a USDC paywall — you keep the model, the money, and the keys.</p>

---

airlock turns an **agentic process** — a real agent with its harness, tools, and multi-step loop — into a service anyone can call with a stock OpenAI client, self-hosted on your own box. The agent answers `POST /v1/chat/completions`, runs its full native loop, and returns the result. Payment settles on-chain from caller to your wallet; airlock **never hosts inference** (the model is always yours), and only operates the tunnel — never your request path.

- **Self-host first:** run it on your own hardware behind an ephemeral airlock tunnel (**no account needed**), or upgrade to a stable URL on **your own** Cloudflare domain (`airlock up --durable`). airlock operates no hosting on your behalf.
- **Harness-agnostic:** **smolagents, LangGraph, CrewAI, the OpenAI Agents SDK, or the Claude Agent SDK** all run behind one shared `airlock-agent` runtime — `airlock init --detect` wires yours with no adapter to write.
- **OpenAI-compatible:** the agent speaks `/v1/chat/completions`, so any existing chat client or SDK works unchanged — the multi-step run's final answer is the completion.
- **You own the model:** a local gguf/vLLM on your box, or a remote `OPENAI_API_BASE`. airlock never hosts inference.
- **Direct settlement:** USDC goes caller-wallet → your wallet on Base. No custody, no KYC, no revenue cut.
- **Open source, day one:** Apache-2.0.

## Ways to get a public URL

| Mode | Compute | Public URL | Account you bring |
| --- | --- | --- | --- |
| **Self-host** (default) | your hardware (Mac mini / server) | ephemeral airlock quick tunnel | **none** |
| **Self-host + durable** | your hardware | a stable URL on **your own** domain | your Cloudflare account |

`airlock up` self-hosts on your box and fronts it with a public URL — **no account needed** for the default ephemeral tunnel. For a *stable* URL you bring your own Cloudflare account (a named tunnel under your own domain — `airlock up --durable`; see [durable hosting](./docs/durable-hosting.md)). airlock holds no keys and operates no hosting infrastructure on your behalf.

## Self-host: run your agent on your own machine

Your harness (smolagents, LangGraph, CrewAI, …) runs where you run it; airlock fronts it with a public URL. Example with a **smolagents** harness and a **local** model:

```bash
# 1. Install the CLI
npm i -g @airlockhq/cli

# 2. Detect your harness + wire it (writes .airlock/config.toml, mode=self-hosted)
airlock init my-agent --self-host --detect
#   → detected smolagents; wired smol_harness.agent:build_agent — confirm or edit

# 3. Install your deps + the airlock runtime (vendored locally until it's on PyPI)
pip install -r requirements.txt
pip install ./.airlock/vendor/payment-fly ./.airlock/vendor/agent-runtime

# 4. Point at your model — a local gguf …
export SMOL_HARNESS_MODEL=./models/Llama-3.2-1B-Instruct-Q4_K_M.gguf
#   … or a remote endpoint instead:  export OPENAI_API_BASE=…  OPENAI_API_KEY=…

# 5. Go live — runs the agent + opens a public URL
airlock up
#   ✓ live at https://<name>.trycloudflare.com
```

Any OpenAI client can now call it from anywhere:

```bash
curl -s https://<name>.trycloudflare.com/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"what is 23 times 19?"}]}'
# → {"choices":[{"message":{"role":"assistant","content":"437"}}], ...}
```

No cloud account, no Docker — **your hardware, your model, your keys.** (`airlock up` uses an ephemeral `*.trycloudflare.com` URL by default; for a stable URL on **your own** domain, bring your own Cloudflare account and run `airlock up --durable` — see [durable hosting](./docs/durable-hosting.md).)

### Supported harnesses

| Harness | Framework | Example |
| --- | --- | --- |
| `smolagents` | Hugging Face smolagents (code agents) | [`examples/smolagent-local`](./examples/smolagent-local/) |
| `langgraph` | LangGraph | [`examples/langgraph-agent`](./examples/langgraph-agent/) |
| `crewai` | CrewAI | [`examples/crewai-agent`](./examples/crewai-agent/) |
| `openai-agents` | OpenAI Agents SDK | [`examples/openai-agents-agent`](./examples/openai-agents-agent/) |
| `claude` | Claude Agent SDK | [`examples/claude-agent`](./examples/claude-agent/) |

Each example is a complete, forkable reference — just an `agent.py` plus an `[agent]` config block (no adapter to write). `airlock init --detect` reads your deps + imports to pick the harness and locate the entrypoint; the shared `airlock-agent` runtime drives its native loop, mounts payment in-process, and serves an [`airlock-config`](https://github.com/Okohedeki/airlock-config) discovery bundle if present.

## It runs a real agent loop (not one LLM call)

A request to `/v1/chat/completions` runs the harness's **full native loop** server-side — decompose → call a tool → observe → re-plan → answer — and you can watch the steps stream in the agent's logs. Verified multi-step tool-chaining (smolagents harness, local model):

| Prompt | Tools chained across steps | Result |
| --- | --- | --- |
| multiply 23×19, raise to the power 2, then what % 5000 is of that | `multiply` → `power` → `percentage` | `2.618…%` |
| write `note.txt`, read it back, count the words | `write_file` → `read_file` → `word_count` (leaves a real file) | `5` |
| search the web for Python's release year, then % of 2000 | `web_search` → `percentage` | searched value flows into the math tool |

The tell that it's genuinely agentic (not a canned reply): the final number is **arithmetically derived from an earlier step's tool output** — the percentage exactly equals `value / 2000 × 100` for the value the web step retrieved. A single LLM call can't manufacture that cross-step linkage.

## Tips for a reliable agentic harness

Hard-won from wiring real harnesses behind airlock:

- **Authorize the code sandbox's imports.** A smolagents `CodeAgent` runs model-written Python under an import allowlist — if the model reaches for `bs4`/`json`/etc. and it isn't allowed, the step hard-fails with `Forbidden function evaluation`. Pass `additional_authorized_imports=[…]` for the safe libs your tools' outputs invite.
- **Tell the model the truth about tool outputs — and don't over-specify.** `visit_webpage` returns **markdown text to read**, not HTML to parse. A too-precise hint like "the heading starts with `#`" backfires (markdownify underlines headings with `=`), sending weaker models on multi-step regex dead-ends. Say "read the returned text and answer," not "extract tag X."
- **Model capability dominates.** A 1B handles a single tool step (`multiply` → 437) but flails at multi-step orchestration (search → read → extract); a 7B+ chains reliably. If the loop is correct but answers are wrong, upgrade the model — not the harness.
- **Keep skills as small, well-described tool bundles** with guidance on *when* to use each — the model selects tools from their descriptions.
- **It's stateless per call.** The conversation resets each request (clean multi-caller isolation + per-call billing); resend history client-side for multi-turn.
- **Restart to reload.** The agent is built **once** at startup, so config/code/model changes only take effect on the next `airlock up`.

## Environment variables

A committed [`.env.example`](./.env.example) lists every variable airlock reads, grouped by use case. Copy it to `.env` (gitignored) and fill in only what you use. The essentials:

| Variable | Used when | What it is |
| --- | --- | --- |
| `OPENAI_API_BASE` | your model is remote (vLLM endpoint, OpenAI-compatible provider) | URL the runtime calls for inference |
| `OPENAI_API_KEY` | your model is remote and requires auth | bearer token for the upstream model |
| `SMOL_HARNESS_MODEL` | your model is a local gguf | filesystem path to the model file |
| `AIRLOCK_CF_TUNNEL_TOKEN` | `airlock up --durable` (your own Cloudflare named tunnel for a stable URL) | connector token from your Cloudflare Zero Trust dashboard |
| `AIRLOCK_MAX_CONCURRENCY` | tuning parallel-request capacity | hard cap on concurrent runs (default sized to the model) |
| `AIRLOCK_MAX_WAIT_S` | tuning admission control | per-request queue budget before returning `429 Retry-After` |
| `AIRLOCK_WALLET_KEY` / `AIRLOCK_WALLET_PASSWORD` | running the optional `airlock-agent[crypto]` buy tool | self-custody wallet credentials, defined in [`airlock-crypto`](https://github.com/Okohedeki/airlock-crypto) |

airlock **never reads any cloud-provider secrets itself** — when you self-host, the only credential it cares about is the Cloudflare tunnel token (and only if you opt into `--durable`). Model API keys are read directly by your harness; tunnel credentials by the connector. See the inline comments in `.env.example` for the full set and which command needs each.

### Just wrapping a model? (dev convenience)

To put a paywall in front of a bare OpenAI-compatible model (no agent loop), `serve` is a dev-only proxy:

```bash
airlock serve --upstream http://localhost:8080 --no-payment --tunnel   # bundled cloudflared → public URL
```

## CLI

```bash
airlock init my-agent --self-host --detect   # detect harness, wire [agent], self-host mode
airlock up                                    # SELF-HOST: run your agent here + public URL
airlock serve --upstream http://localhost:8080 --tunnel  # DEV-ONLY proxy for a bare model
airlock dev -p 3000                           # public Cloudflare tunnel to an already-running agent
airlock doctor                                # validate config + report discovery bundle
airlock login / sync / whoami                 # dashboard auth + project registration
```

See the [full CLI reference](./docs/cli.md).

## Docs

|     |     |
| --- | --- |
| [`examples/`](./examples/) | Forkable agent references for all five harnesses. |
| [`docs/cli.md`](./docs/cli.md) | Every command and flag. |
| [`docs/payment.md`](./docs/payment.md) | Payment Middleware reference: config schema, flat vs per-token. |
| [`docs/adr/`](./docs/adr/) | Locked decisions: never hold prod traffic, harness adapters, never host inference, x402. |

## What airlock is, what it isn't

**It is:** a way to run an agent (any harness) behind an OpenAI-compatible, paywalled URL, self-hosted on your hardware; a shared runtime (`airlock-agent`) + config-driven harness binding; payment middleware (in-process FastAPI/Node); a CLI (`airlock up` for self-host); a dashboard for paid calls and revenue.

**It isn't:** a hosted inference runtime ([ADR-0008](./docs/adr/0008-airlock-never-hosts-inference.md) — the model is always yours, local or remote); a custodian (USDC settles wallet-to-wallet). airlock only operates the (optional) tunnel and stays out of your request path. The payer side — agent wallets that buy *and* sell over x402 — lives in the sister repo [`airlock-crypto`](https://github.com/Okohedeki/airlock-crypto) ([ADR-0006](./docs/adr/0006-wallets-in-airlock-crypto.md)); airlock itself still holds no keys.

## The airlock ecosystem

airlock is the deploy/host core of a small family of repos, split by concern. Each is optional and composes with the rest:

| Repo | What it does |
| --- | --- |
| **airlock** (this repo) | Run an agent behind a paid, OpenAI-compatible x402 URL — self-hosted. The **host + sell** side. |
| [**airlock-config**](https://github.com/Okohedeki/airlock-config) | Declare an agent's skills, pricing, region, and compliance → a static `/.well-known` bundle airlock serves. The **describe + discover** side. |
| [**airlock-crypto**](https://github.com/Okohedeki/airlock-crypto) | Self-custody agent wallets that **buy** (autopay another agent's x402 paywall) and **sell** (flip on this repo's receiver). The **pay** side; wired here as the optional `airlock-agent[crypto]` buy tool. |
| **airlock-directory** | A searchable registry agents opt into to be discoverable by capability/price/region/status. The **find** side; backed by Supabase, browsable at [airlock-directory.pages.dev](https://airlock-directory.pages.dev). |

## Roadmap & To-Do

**Shipped:** self-host (`airlock up`) with a public Cloudflare tunnel · **durable self-host URL** — a stable hostname on your **own** Cloudflare account via `airlock up --durable` ([durable hosting](./docs/durable-hosting.md)) · config-driven harness binding for all five harnesses · in-process x402 payment · capped-parallel concurrency via per-call isolation + a bounded queue ([ADR-0010](./docs/adr/0010-per-call-agent-isolation.md), `scripts/concurrency-check.sh`) · **scale & latency** — latency-aware admission (`429` + `Retry-After`), SSE streaming, connector tuning + supervision, and `/metrics` ([scaling on Cloudflare](./docs/scaling-cloudflare.md), [ADR-0011](./docs/adr/0011-scaling-on-cloudflare-named-tunnel-replicas.md)) · **`airlock-crypto` v1** — a Python-first x402 transaction layer so an agent can buy *and* sell from other agents (self-custody wallet + autopay + spend cap; [ADR-0006](./docs/adr/0006-wallets-in-airlock-crypto.md)).

What's left, grouped. Everything runs on accounts **you** own — airlock operates no hosting infrastructure on your behalf.

**`airlock-crypto` — next**
- [ ] Publish `airlock-crypto` to PyPI + its own repo; wire the optional `airlock-agent[crypto]` buy tool into the harness adapters so a model can call `buy(url)`.
- [ ] Implement the TypeScript `WalletProvider` (`payment-core/src/crypto.ts`, today a stub) over the same x402 libs for TS callers; prepaid Credit Balance + per-token billing.

**`airlock-directory` — searchable agent registry ("DNS for agents")**
- [ ] A central index a publisher opts into with a flag (e.g. `airlock up --list` / `directory.searchable = true`) so their deployed agent becomes discoverable and searchable by capability, price, and region. Composes with [`airlock-config`](https://github.com/Okohedeki/airlock-config) — the per-agent bundle is the record, the directory is the searchable index across them. Its v1 mechanism already exists as airlock-config's `register-entry` / `search` (a GitHub-list JSON index); `airlock-directory` is that index's home + the deploy-flag on-ramp. **Opt-in only — private by default.**

**Durable self-host URL** — stable hostname on your own domain instead of the ephemeral `*.trycloudflare.com`
- [x] **Shipped (bring-your-own Cloudflare):** `tunnel.ts` `startNamedTunnel(token)`, a `[tunnel]` config block, `airlock up --durable`, and `airlock doctor` credential checks. The publisher supplies their own Cloudflare account + domain + connector token (`AIRLOCK_CF_TUNNEL_TOKEN`); airlock holds no keys. See [durable hosting](./docs/durable-hosting.md).
- [ ] *Optional convenience:* automate tunnel + DNS-route creation via the publisher's Cloudflare **API** token so they can skip the dashboard setup.

**Scale & latency** — handle many concurrent requests at low latency ([scaling on Cloudflare](./docs/scaling-cloudflare.md), [ADR-0011](./docs/adr/0011-scaling-on-cloudflare-named-tunnel-replicas.md)). *Short-term is shipped; the long-term model/cluster layer is open.*
- [x] **Per-box, shipped:** latency-aware admission (run-time EWMA + `AIRLOCK_MAX_WAIT_S` budget → `429` + `Retry-After`, no more blind timeout); SSE streaming Tier A (heartbeat — every harness, TTFB ~0) + per-token streamed billing; `AIRLOCK_MAX_CONCURRENCY` = the model's real parallel capacity; `/metrics` + live gate stats.
- [x] **Tunnel, shipped:** connector tuning (`--cf-protocol`/`--cf-region`/`--cf-metrics` + `[tunnel]` keys) and **supervision** (reconnect with backoff on unexpected exit). Multi-box fan-out = N connector replicas on one token (Cloudflare balances across them).
- [ ] **Per-harness real streaming (Tier B):** wire smolagents/langgraph/claude into the shipped `run_stream` interface — needs a live model to verify the step→delta mapping (the generic mechanism is done).
- [ ] **Adaptive concurrency:** auto-tune the effective cap from observed latency (AIMD) so a mis-set `AIRLOCK_MAX_CONCURRENCY` can't over-subscribe the model.
- [ ] **Verify + automate multi-box:** prove N replicas on one token against real Cloudflare; add the **Cloudflare Load Balancing** on-ramp (health pools / regional steering / failover), optionally via the CF API token.
- [ ] **Model-layer scale (the true ceiling):** a single non-batching/in-process model still serializes — detect it and guide to vLLM / `llama-server --parallel` / a fast remote provider; ship a recommended batching-server recipe.
- [ ] **Robustness:** cancel the in-flight run on client disconnect (today the slot frees but the run continues); cluster-wide metrics + backpressure beyond per-box `429`.

**Shared plumbing**
- [ ] `db.ts` per-mode columns (drop the `target` CHECK → zod validation), mode-aware `doctor`.
- [ ] ADR-0009 (dual-deploy, narrows ADR-0001) + CONTEXT / ADR-0002 / ADR-0003 updates.

**Enterprise seams (interfaces only)**
- [ ] `payment-core/auth.ts` `CallerAuthStrategy`; nullable `org_id`/`owner_kind` + stub `orgs`; extend `InspectCallSchema` (shape/request_id/settlement_tx/event_version); doc the `exec.ts` Target switch as the 3rd-Target extension point.

**Polish & packaging**
- [x] Tunnel region pinning (`--cf-region` / `[tunnel].region`) + connector supervision.
- [ ] SIGTERM cleanup (cloudflared orphans on `SIGTERM`).
- [ ] Docs: `payment.md`, `cli.md`, reconcile CONTEXT "v1 does not scaffold".
- [ ] **npm-publish caveat**: `--detect` vendoring reads repo-root `./python` (not in npm `files`) → bundle the Python sources or switch to a git-install before shipping `@airlockhq/cli`.
- [ ] Live-verify langgraph/crewai/openai/claude against a capable model; E2B sandbox behind `SandboxProvider`; Python starter template.

## Discovery — composes with `airlock-config`

[`airlock-config`](https://github.com/Okohedeki/airlock-config) is the sister discovery layer: a publisher declares an agent's skills, pricing, region, and compliance in `airlock-config.yaml` and `airlock-config build` emits a static bundle. airlock **serves that bundle's well-known files automatically** when present, so other agents discover yours without coordination. It's optional — deploy works fine without a contract.

## Development

```
packages/cli            the `airlock` CLI (init/up/serve/dev/doctor/login/sync)
packages/server         dashboard backend (GitHub OAuth, projects, inspect store)
packages/payment-core   shared x402 + usage units + Wallet/Sandbox seams
packages/payment-*      Payment Middleware (in-process Node/Workers)
python/payment-fly      airlock-payment (FastAPI/Starlette middleware — name is historical)
python/agent-runtime    airlock-agent (OpenAI-chat surface + HarnessAdapter)
examples/*-agent        forkable agent references, one per harness
```

```bash
pnpm install && pnpm build && pnpm typecheck && pnpm test   # JS/TS workspace
# Python: airlock-agent surface + adapters + middleware (pytest)
```

---

<p align="center">
  <a href="https://star-history.com/#Okohedeki/airlock&Date">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Okohedeki/airlock&type=Date&theme=dark">
      <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Okohedeki/airlock&type=Date">
      <img src="https://api.star-history.com/svg?repos=Okohedeki/airlock&type=Date" alt="Star history chart for Okohedeki/airlock" width="600" style="max-width: 100%;">
    </picture>
  </a>
</p>

## License

[Apache-2.0](./LICENSE)
