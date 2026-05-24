# agent-template

A **forkable, model-free reference agent**. It does real work — fetch a web page, extract its title and word count — and mounts the airlock payment middleware **in-process** on its own `POST /run` route. No model required; no separate proxy. This is the canonical shape for *deploying an agentic process to a paid web URL*.

The LLM is an **optional dependency**: set `OPENAI_API_KEY` and the agent also returns a one-sentence summary. Everything else works without it.

## Run it

```bash
pnpm install
pnpm --filter @airlockhq/example-agent-template dev
```

Then, in another terminal:

```bash
# Payment is OFF by default — just works.
curl -s -X POST http://localhost:3000/run \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com"}' | jq
```

You'll get `{ url, title, wordCount, summary }`. The handler reports `usage: { units: wordCount, unitLabel: 'words' }` — so per-token billing meters by words read, proving metered billing isn't LLM-specific.

## Turn on payment

```bash
PAYMENT_ENABLED=1 \
  PUBLISHER_WALLET=0xYourWalletAddress \
  PAYMENT_NETWORK=base-sepolia \
  PRICE_USDC=0.001 \
  pnpm --filter @airlockhq/example-agent-template dev
```

Now the same call returns **HTTP 402** with the x402 PaymentRequired body. Pay it with the bundled client:

```bash
# Unpaid — shows the 402 + requirements
pnpm --filter @airlockhq/example-agent-template client https://example.com

# Paid — needs a Base Sepolia wallet funded with test USDC (https://faucet.circle.com/)
PRIVATE_KEY=0x<test-key> \
  pnpm --filter @airlockhq/example-agent-template client https://example.com
```

For per-token (session) billing — settle once, then debit per call without re-paying:

```bash
PAYMENT_ENABLED=1 PAYMENT_MODE=per_token PUBLISHER_WALLET=0x... \
  pnpm --filter @airlockhq/example-agent-template dev
```

## Expose it publicly

```bash
airlock dev -p 3000          # bundled Cloudflare tunnel → public https URL
```

## Deploy it

```bash
airlock doctor               # validate .airlock/config.toml
airlock deploy               # wraps `fly deploy` → https://<app>.fly.dev
```

The middleware runs **inside** this process, so in production airlock only orchestrates the deploy — it never sits in your request path.

## Make it yours

Replace the body of the `POST /run` handler in [`src/server.ts`](./src/server.ts) with your agent logic (LangGraph, CrewAI, a tool loop, anything). Return `{ status, body, usage }` — set `usage.units` to whatever you meter. The payment + reporting layer doesn't care what's inside.
