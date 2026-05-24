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

<p align="center"><strong>ngrok for AI agents.</strong> Wrap a local LLM or self-hosted model with an x402 USDC paywall and a dashboard — without giving up custody, KYC, or a revenue cut.</p>

---

Point airlock at any OpenAI-compatible upstream — llama.cpp on your laptop, vLLM on a GPU box, Ollama on your homelab — and it exposes the model with payment enforcement, request logging, and a publisher dashboard. USDC settles on Base directly from caller to publisher wallet. No middleman in the prod request path.

- **Self-hosted runtime:** Your model runs on your hardware or your cloud account. airlock never sits in the prod inference path.
- **Direct settlement:** Payments go caller-wallet → publisher-wallet on-chain. We never custody money. No KYC. No revenue cut.
- **Works with what you already run:** Any OpenAI-compatible `POST /v1/chat/completions` upstream — llama.cpp, Ollama, LM Studio, vLLM, TGI.
- **Pluggable middleware:** Wrap an existing service with `airlock serve`, or import the Payment Middleware for Workers, Node/Fly, or FastAPI/Starlette.
- **Open source, day one:** Apache-2.0. CLI and Recipes are self-hostable. The paid product is the dashboard we operate.

## Getting Started

### Prerequisites

A local LLM that speaks OpenAI's `/v1/chat/completions`. Any of these work out of the box:

- [llama.cpp](https://github.com/ggerganov/llama.cpp) (`llama-server`)
- [Ollama](https://ollama.com)
- [LM Studio](https://lmstudio.ai)
- [vLLM](https://github.com/vllm-project/vllm)

You'll also want an EVM wallet address for receiving USDC on Base.

### 30-second dev quickstart

```bash
# 1. Wrap your local model with payment + reporting
npx -y @airlockhq/cli serve \
  --upstream http://localhost:8080 \
  --port 3000 \
  --wallet 0xYourWalletAddress \
  --price 0.001

# 2. Make it public
cloudflared tunnel --url http://localhost:3000
```

Unpaid callers get HTTP `402 Payment Required`. Paid callers' USDC lands in your wallet on Base.

For the full local-LLM walkthrough (llama.cpp + Metal on a Mac), see [`docs/llama-cpp-on-fly.md`](./docs/llama-cpp-on-fly.md).

### Production deploy

Local `serve` is bottlenecked by your laptop's tk/s. For real traffic, run the model on a GPU box you own. Fly.io is the v1 default; Cloudflare Workers is the alternative for stateless TS agents.

```bash
# In your agent's project directory
npx -y @airlockhq/cli init my-agent --target=fly
# Edit .airlock/config.toml — set payment.wallet to your address

npx -y @airlockhq/cli doctor          # validate
npx -y @airlockhq/cli deploy          # wraps `fly deploy`
npx -y @airlockhq/cli login           # GitHub device-flow → dashboard
npx -y @airlockhq/cli sync            # register project with the dashboard
```

You now have a public, paid endpoint on Fly, and the dashboard at `http://localhost:8787/projects/<id>` shows revenue, paid calls, unique callers, and per-call request/response detail.

## CLI

```bash
airlock serve --upstream http://localhost:8080 --port 3000 --wallet 0x... --price 0.001
airlock init my-agent --target=fly                  # scaffold .airlock/config.toml + Dockerfile
airlock doctor                                      # validate config + upstream reachability
airlock deploy                                      # wraps `fly deploy` / `wrangler deploy`
airlock login                                       # GitHub device-flow → dashboard auth
airlock sync                                        # register project with the dashboard
airlock whoami                                      # show authed identity
```

See the [full CLI reference](./docs/cli.md) for every flag.

## Docs

|     |     |
| --- | --- |
| [`docs/llama-cpp-on-fly.md`](./docs/llama-cpp-on-fly.md) | End-to-end: llama.cpp locally → containerized on Fly GPU → paywalled. |
| [`docs/cli.md`](./docs/cli.md) | Every command, every flag, what it shells out to. |
| [`docs/payment.md`](./docs/payment.md) | Payment Middleware reference: config schema, flat vs per-token, wiring into Workers / Express / FastAPI. |
| [`examples/local-llm-agent`](./examples/local-llm-agent/) | Runnable end-to-end demo (Ollama-fronted). |
| [`docs/adr/`](./docs/adr/) | Locked design decisions: hosted dev tunnel, dev-free / prod-paid pricing, two Targets at v1, OSS-first, x402 over Stripe. |

## What airlock is, what it isn't

**It is:**

- A CLI that wraps `wrangler` / `flyctl` with airlock-aware defaults for deploys.
- A local HTTP wrapper (`airlock serve`) that adds x402 + dashboard reporting in front of any OpenAI-compatible upstream.
- Three Payment Middlewares — `@airlockhq/payment-workers`, `@airlockhq/payment-fly-node`, `airlock-payment` (PyPI) — for containers you build yourself.
- A dashboard backend that tracks projects, calls, and revenue per GitHub identity.

**It isn't:**

- A hosted inference runtime. Your model runs on your laptop (dev) or in your cloud account (prod). airlock never sits in the prod request path.
- A custodian. Payments settle on-chain from caller wallet to publisher wallet directly.
- A KYC / payout service. Wallets are wallets.

This isn't going to change. See [ADR-0001](./docs/adr/0001-we-operate-the-hosted-dev-tunnel.md) for the "never hold prod traffic" invariant and [ADR-0005](./docs/adr/0005-x402-for-monetization.md) for the x402 rationale.

## Composes with agent contracts

```
agent contract files          airlock (this repo)
  contract.yaml      ──►       reads for metadata
  build → bundle     ──►       serves at /.well-known/contract.yaml
  codegen → stubs    ──►       wires into the deployed entry point
```

airlock treats agent-contract files as immutable inputs and never modifies them. If your agent isn't contract-aware, that's fine — MCP, A2A, OpenAI tools, and plain REST all work.

## Development

Monorepo package map:

- `packages/cli` — the `airlock` CLI (`serve`, `init`, `doctor`, `deploy`, `login`, `sync`)
- `packages/server` — dashboard backend (GitHub OAuth, projects, inspect store) on `:8787`
- `packages/payment-core` — shared x402 envelope + config schema + ledger interface
- `packages/payment-workers` — Payment Middleware for Cloudflare Workers
- `packages/payment-fly-node` — Payment Middleware for Node / Express on Fly
- `python/payment-fly` — `airlock-payment` (PyPI) for FastAPI / Starlette
- `examples/local-llm-agent` — runnable demo wrapping a local Ollama upstream

Common commands:

```bash
pnpm install              # install workspace deps
pnpm build                # build every package
pnpm typecheck            # repo-wide typecheck
pnpm test                 # repo-wide vitest
pnpm check                # biome lint + format check

# Python middleware
cd python/payment-fly && pip install -e '.[dev]' && pytest
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
