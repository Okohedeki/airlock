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

<p align="center"><strong>Deploy any AI agent to a paid web URL.</strong> Take an agent built in any framework, expose it behind a standard OpenAI-compatible endpoint with a USDC paywall, and ship it to your own cloud — you keep the model, the money, and the keys.</p>

---

airlock turns an **agentic process** — a real agent with its harness, tools, and multi-step loop — into a deployed service anyone can call with a stock OpenAI client. The agent answers `POST /v1/chat/completions`, runs its full native loop server-side, and returns the result. Payment settles on-chain from caller to your wallet; airlock never sits in the production request path and never hosts inference.

- **Harness-agnostic:** wrap **smolagents, LangGraph, CrewAI, the OpenAI Agents SDK, or the Claude Agent SDK** behind one shared surface. A new framework is a ~30-line adapter.
- **OpenAI-compatible:** the deployed agent speaks `/v1/chat/completions`, so any existing chat client or SDK works unchanged — the multi-step run's final answer is the completion.
- **You own the model:** the model is a dependency you supply via `OPENAI_API_BASE` (self-hosted vLLM/llama.cpp, a fast OS-model provider, or Anthropic for Claude). airlock never hosts inference — pick fast providers for speed; the same open weights, far cheaper than self-hosting.
- **Direct settlement:** USDC goes caller-wallet → your wallet on Base. No custody, no KYC, no revenue cut.
- **Open source, day one:** Apache-2.0. Run a fully open stack with zero airlock-operated infrastructure.

## Getting Started

```bash
# 1. Scaffold an agentic service for your framework (Fly target)
npx -y @airlockhq/cli init my-analyst --target=fly --agent=langgraph

# 2. Drop your agent into adapter.py (run its full loop), point at a model
pip install -r requirements.txt
export OPENAI_API_BASE=http://localhost:8080/v1   # local llama in dev

# 3. Run it — any OpenAI client can now call it
python app.py
curl -s localhost:3000/v1/chat/completions -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"analyze TSLA"}]}'
```

### Supported harnesses

| `--agent=` | Framework | Example |
| --- | --- | --- |
| `smolagents` | Hugging Face smolagents (code agents) | [`examples/smolagent-local`](./examples/smolagent-local/) |
| `langgraph` | LangGraph | [`examples/langgraph-agent`](./examples/langgraph-agent/) |
| `crewai` | CrewAI | [`examples/crewai-agent`](./examples/crewai-agent/) |
| `openai-agents` | OpenAI Agents SDK | [`examples/openai-agents-agent`](./examples/openai-agents-agent/) |
| `claude` | Claude Agent SDK | [`examples/claude-agent`](./examples/claude-agent/) |

Each example is a complete, forkable reference: the adapter binds the harness to the shared `airlock-agent` surface, mounts payment in-process, and serves an [`airlock-config`](https://github.com/Okohedeki/airlock-config) discovery bundle if present.

### Deploy

```bash
npx -y @airlockhq/cli secret set OPENAI_API_BASE=… OPENAI_API_KEY=…   # → fly secrets
npx -y @airlockhq/cli doctor          # validate
npx -y @airlockhq/cli deploy          # wraps `fly deploy` → https://<app>.fly.dev
```

Your agent now lives at a public URL on **your** Fly account. airlock only ran `fly deploy` — it never touches your traffic.

### Just wrapping a model? (dev convenience)

If you only want to put a paywall in front of a local OpenAI-compatible model, `serve` is a dev-only proxy:

```bash
airlock serve --upstream http://localhost:8080 --no-payment --tunnel   # bundled cloudflared → public URL
```

## CLI

```bash
airlock init my-agent --target=fly --agent=langgraph   # scaffold an agentic service
airlock serve --upstream http://localhost:8080 --tunnel # DEV-ONLY proxy for a local model
airlock dev -p 3000                                     # public Cloudflare tunnel to a local agent
airlock doctor                                          # validate config + report discovery bundle
airlock deploy                                          # wraps `fly deploy` / `wrangler deploy`
airlock secret set OPENAI_API_KEY=…                     # → fly/wrangler secrets
airlock login / sync / whoami                           # dashboard auth + project registration
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

**It is:** a way to deploy an agent (any harness) behind an OpenAI-compatible, paywalled URL on your own cloud; a shared runtime (`airlock-agent`) + per-harness adapters; payment middleware (Workers, Node/Fly, FastAPI); a CLI that wraps `flyctl` / `wrangler`; a dashboard for paid calls and revenue.

**It isn't:** a hosted inference runtime ([ADR-0008](./docs/adr/0008-airlock-never-hosts-inference.md) — the model is yours); a custodian (USDC settles wallet-to-wallet); a thing in your prod request path ([ADR-0001](./docs/adr/0001-we-operate-the-hosted-dev-tunnel.md)). Wallet creation/funding lives in a separate repo, `airlock-crypto` ([ADR-0006](./docs/adr/0006-wallets-in-airlock-crypto.md)).

## Discovery — composes with `airlock-config`

[`airlock-config`](https://github.com/Okohedeki/airlock-config) is the sister discovery layer: a publisher declares an agent's skills, pricing, region, and compliance in `airlock-config.yaml` and `airlock-config build` emits a static bundle. airlock **serves that bundle's well-known files automatically** when present, so other agents discover yours without coordination. It's optional — deploy works fine without a contract.

## Development

```
packages/cli            the `airlock` CLI (init/serve/dev/deploy/doctor/login/sync)
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
