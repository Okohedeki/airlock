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

<p align="center"><strong>Run any AI agent behind a paid, OpenAI-compatible URL — on your own hardware, or handed to airlock.</strong> Take an agent built in any framework, expose it at <code>POST /v1/chat/completions</code> with a USDC paywall — you keep the model, the money, and the keys.</p>

---

airlock turns an **agentic process** — a real agent with its harness, tools, and multi-step loop — into a service anyone can call with a stock OpenAI client, **either self-hosted on your own box or hosted by airlock**. The agent answers `POST /v1/chat/completions`, runs its full native loop, and returns the result. Payment settles on-chain from caller to your wallet; airlock **never hosts inference** (the model is always yours), and when you self-host it only operates the tunnel — never your request path.

- **Two ways to host:** **self-host** on your own hardware (a local model, fully offline if you like) or go **airlock-hosted** (we run a per-agent microVM; you bring a remote model key). No cloud account required either way.
- **Harness-agnostic:** **smolagents, LangGraph, CrewAI, the OpenAI Agents SDK, or the Claude Agent SDK** all run behind one shared `airlock-agent` runtime — `airlock init --detect` wires yours with no adapter to write.
- **OpenAI-compatible:** the agent speaks `/v1/chat/completions`, so any existing chat client or SDK works unchanged — the multi-step run's final answer is the completion.
- **You own the model:** a local gguf/vLLM on your box, or a remote `OPENAI_API_BASE`. airlock never hosts inference.
- **Direct settlement:** USDC goes caller-wallet → your wallet on Base. No custody, no KYC, no revenue cut.
- **Open source, day one:** Apache-2.0.

## Two ways to host

| Mode | Compute | Model | Public URL | Cloud account |
| --- | --- | --- | --- | --- |
| **Self-host** | your hardware (Mac mini / server) | local **or** remote | airlock tunnel | none |
| **airlock-hosted** | airlock's Fly microVM | remote (your key) | `<app>.fly.dev` | none |

Both run the same `python -m airlock_agent` runtime with payment in-process. You never need a cloud account: self-host runs on your box; airlock-hosted provisions on airlock's infra with a token the backend mints for you.

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

No Fly account, no Docker, no `fly auth login` — **your hardware, your model, your keys.** (`airlock up` currently uses an ephemeral `*.trycloudflare.com` URL; a stable `<name>.airlock.dev` for signed-in users is in progress.)

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

## airlock-hosted: let airlock run it (managed)

Don't want to keep a box running? airlock provisions a per-agent microVM on its **own** Fly org and hands you a `<app>.fly.dev` URL — you bring a remote model key (`OPENAI_API_BASE`), airlock never hosts inference. Same `[agent]` config, `mode=airlock-hosted`; the backend mints a short-lived, app-scoped deploy token so **you still need no Fly account**.

> Status: self-host (`airlock up`) is the path you can run today; the airlock-hosted managed prong is being built behind the same config + token-minting pattern.

### Power option: deploy to a cloud you own

Prefer to own the infra? `airlock deploy` still ships to **your** Fly/Cloudflare account (you run `fly auth login` once); airlock only wraps `fly deploy` / `wrangler deploy` and never touches your traffic.

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
airlock deploy                                # ship to a cloud you own (wraps fly/wrangler deploy)
airlock secret set OPENAI_API_KEY=…           # secrets on the target
airlock login / sync / whoami                 # dashboard auth + project registration
```

See the [full CLI reference](./docs/cli.md).

## Docs

|     |     |
| --- | --- |
| [`examples/`](./examples/) | Forkable agent references for all five harnesses. |
| [`docs/cli.md`](./docs/cli.md) | Every command and flag. |
| [`docs/payment.md`](./docs/payment.md) | Payment Middleware reference: config schema, flat vs per-token. |
| [`docs/llama-cpp-on-fly.md`](./docs/llama-cpp-on-fly.md) | Running a local model + the dev `serve` loop. |
| [`docs/adr/`](./docs/adr/) | Locked decisions: never hold prod traffic, harness adapters, never host inference, x402. |

## What airlock is, what it isn't

**It is:** a way to run an agent (any harness) behind an OpenAI-compatible, paywalled URL — self-hosted on your hardware or hosted by airlock; a shared runtime (`airlock-agent`) + config-driven harness binding; payment middleware (Workers, Node/Fly, FastAPI); a CLI (`airlock up` for self-host, plus `deploy` wrapping `flyctl`/`wrangler`); a dashboard for paid calls and revenue.

**It isn't:** a hosted inference runtime ([ADR-0008](./docs/adr/0008-airlock-never-hosts-inference.md) — the model is always yours, local or remote); a custodian (USDC settles wallet-to-wallet). When you self-host, airlock only operates the tunnel and stays out of your request path; airlock-hosted runs the agent loop for you but never the model. Wallet creation/funding lives in a separate repo, `airlock-crypto` ([ADR-0006](./docs/adr/0006-wallets-in-airlock-crypto.md)).

## Roadmap & To-Do

**Shipped:** self-host (`airlock up`) with a public Cloudflare tunnel · config-driven harness binding for all five harnesses · in-process x402 payment · capped-parallel concurrency via per-call isolation + a bounded queue ([ADR-0010](./docs/adr/0010-per-call-agent-isolation.md), `scripts/concurrency-check.sh`).

What's left, grouped. Items marked **(operator prereq)** need an airlock-owned account/credential before they can ship.

**`airlock-crypto` — the transactions package**
- [ ] Build the sister `airlock-crypto` package that implements the `WalletProvider` seam (`payment-core/src/crypto.ts`, today a throwing stub): wallet create / fund / transfer, on-chain USDC settlement, prepaid Credit Balance, and per-token billing. Keeps custody and key handling out of the core repo ([ADR-0006](./docs/adr/0006-wallets-in-airlock-crypto.md)).

**`airlock-directory` — searchable agent registry ("DNS for agents")**
- [ ] A central index a publisher opts into with a flag (e.g. `airlock up --list` / `directory.searchable = true`) so their deployed agent becomes discoverable and searchable by capability, price, and region. Composes with [`airlock-config`](https://github.com/Okohedeki/airlock-config) — the per-agent bundle is the record, the directory is the searchable index across them. **Opt-in only — private by default.**

**Durable self-host URL** — stable `<name>.airlock.dev` instead of the ephemeral `*.trycloudflare.com`
- [ ] Cloudflare named-tunnel provisioner (`server/cloudflare.ts`), `POST/DELETE /api/self-host/tunnel`, `tunnel.ts` `named(token)` path, `up.ts` minted-token fetch. **(operator prereq: airlock Cloudflare account + domain + API token)**

**airlock-hosted (Fly) prong** — airlock runs a per-agent microVM; you bring a remote model key
- [ ] Gating spike: app-scoped deploy token → remote builder + Machines-API app-create.
- [ ] `server/fly.ts`, `POST /api/hosted-deploy`, env-aware `exec.ts` spawner, cost guards. **(operator prereq: airlock Fly org token)**

**Shared plumbing**
- [ ] `db.ts` per-mode columns (drop the `target` CHECK → zod validation), mode-aware `doctor`.
- [ ] ADR-0009 (dual-deploy, narrows ADR-0001) + CONTEXT / ADR-0002 / ADR-0003 updates.

**Enterprise seams (interfaces only)**
- [ ] `payment-core/auth.ts` `CallerAuthStrategy`; nullable `org_id`/`owner_kind` + stub `orgs`; extend `InspectCallSchema` (shape/request_id/settlement_tx/event_version); doc the `exec.ts` Target switch as the 3rd-Target extension point.

**Polish & packaging**
- [ ] Tunnel region pinning + SIGTERM cleanup (cloudflared orphans on `SIGTERM`).
- [ ] Docs: `payment.md`, `cli.md`, `llama-cpp-on-fly.md`, reconcile CONTEXT "v1 does not scaffold".
- [ ] **npm-publish caveat**: `--detect` vendoring reads repo-root `./python` (not in npm `files`) → bundle the Python sources or switch to a git-install before shipping `@airlockhq/cli`.
- [ ] Live-verify langgraph/crewai/openai/claude against a capable model; E2B sandbox behind `SandboxProvider`; Python starter template.

## Discovery — composes with `airlock-config`

[`airlock-config`](https://github.com/Okohedeki/airlock-config) is the sister discovery layer: a publisher declares an agent's skills, pricing, region, and compliance in `airlock-config.yaml` and `airlock-config build` emits a static bundle. airlock **serves that bundle's well-known files automatically** when present, so other agents discover yours without coordination. It's optional — deploy works fine without a contract.

## Development

```
packages/cli            the `airlock` CLI (init/up/serve/dev/deploy/doctor/login/sync)
packages/server         dashboard backend (GitHub OAuth, projects, inspect store)
packages/payment-core   shared x402 + usage units + Wallet/Sandbox seams
packages/payment-*      Payment Middleware (Workers, Node/Fly)
python/payment-fly      airlock-payment (FastAPI/Starlette middleware)
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
