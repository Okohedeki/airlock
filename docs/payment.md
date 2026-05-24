# Payment quickstart

> Charge Callers per call to your deployed Agent via [x402](https://www.x402.org/) — USDC micropayments over HTTP 402. The Publisher's wallet receives funds directly; `airlock-deploy` never custodies money. See [ADR-0005](./adr/0005-x402-for-monetization.md) for the design decision.

## Pick your Recipe

| Recipe | Package | Use when |
|---|---|---|
| Cloudflare Workers | `@airlock-deploy/payment-workers` | TS, stateless, edge |
| Fly.io / Node | `@airlock-deploy/payment-fly-node` | Node/Express, Docker |
| Fly.io / Python | `airlock-deploy-payment` (PyPI; in [`python/payment-fly`](../python/payment-fly/)) | Python agents (Starlette / FastAPI) |

All Recipes share the same `PaymentConfig` schema — the same `.airlock-deploy/config.toml` works under any of them. Schema lives in `@airlock-deploy/payment-core` (TS) and `airlock_deploy_payment.config` (Python).

## Scaffold a project

The `airlock-deploy` CLI writes the config skeleton + a starter Recipe config for you:

```bash
# Wraps the current directory with .airlock-deploy/config.toml + fly.toml
npx -y @airlock-deploy/cli init my-agent --target=fly

# Or for Cloudflare Workers
npx -y @airlock-deploy/cli init my-worker --target=workers

# Validate the config before deploying
npx -y @airlock-deploy/cli doctor
```

`init` defaults `payment.enabled=false` with a placeholder wallet, so the project is callable for free until you edit the file. `doctor` re-runs the Zod / Pydantic schema and flags the placeholder so you can't ship it accidentally.

## Config

```ts
import { PaymentConfigSchema } from '@airlock-deploy/payment-core';

const config = PaymentConfigSchema.parse({
  enabled: true,
  wallet: '0x1234567890abcdef1234567890abcdef12345678', // your wallet
  network: 'base-sepolia',                              // 'base' for mainnet
  facilitatorUrl: 'https://facilitator.x402.org',       // Coinbase's public one
  description: 'Call my Polymarket prediction agent',
  mode: 'flat',
  priceUsdc: '0.01',                                    // 1 cent per call
});
```

### Pricing modes

**`flat`** — Caller pays `priceUsdc` per call. Fully supported in v1.
```ts
{ mode: 'flat', priceUsdc: '0.001' }  // $0.001 per call
```

**`per_token`** — Caller pre-funds a Credit Balance; per-call cost is `(tokens_used × pricePerTokenUsdc)`, deducted from the balance using the Agent's `X-Tokens-Used` response header. **v1 ships the config + ledger interface; the runtime middleware path lands in v1.1.** Calls in `per_token` mode currently return HTTP 501.
```ts
{ mode: 'per_token', pricePerTokenUsdc: '0.000001', minCreditBalanceUsdc: '0.10' }
```

## Wire it into a Worker

```ts
import { withPayment } from '@airlock-deploy/payment-workers';

export default {
  fetch: withPayment(config, async (request, env, ctx) => {
    const body = await request.json();
    const result = await runMyAgent(body);
    return new Response(JSON.stringify(result), {
      headers: { 'content-type': 'application/json' },
    });
  }),
};
```

## Wire it into FastAPI / Starlette (Fly Python Recipe)

```python
from fastapi import FastAPI
from airlock_deploy_payment import PaymentMiddleware, parse_payment_config

config = parse_payment_config({
    "mode": "flat",
    "wallet": "0x1234567890abcdef1234567890abcdef12345678",
    "network": "base-sepolia",
    "priceUsdc": "0.001",
})

app = FastAPI()
app.add_middleware(PaymentMiddleware, config=config)

@app.post("/chat")
async def chat(body: dict):
    result = await run_my_agent(body)
    return result
```

## Wire it into Express (Fly Node Recipe)

```ts
import express from 'express';
import { withPaymentExpress } from '@airlock-deploy/payment-fly-node';

const app = express();
app.use(express.json());

app.post(
  '/chat',
  withPaymentExpress(config, async (req) => {
    const result = await runMyAgent(req.body);
    return { status: 200, body: result, headers: { 'X-Tokens-Used': '1234' } };
  }),
);

app.listen(3000);
```

The Publisher's handler is an `async (req) => { status, body, headers }` — `airlock-deploy` handles the actual `res.send` so it can attach `X-PAYMENT-RESPONSE` after settlement.

## What happens per request

1. Caller hits your endpoint without `X-PAYMENT` → middleware returns **HTTP 402** with x402 PaymentRequired body
2. Caller's wallet signs an EIP-3009 transfer authorization to your wallet, retries with `X-PAYMENT` header
3. Middleware decodes the header and asks the Facilitator: `verify(payload, requirements)`
4. Facilitator confirms the signature is valid → middleware runs your handler
5. Middleware asks Facilitator to `settle(payload, requirements)` → on-chain transfer commits
6. Middleware attaches `X-PAYMENT-RESPONSE` (settlement details) and returns the handler's response

If verify or settle fails, the handler is rolled back and the Caller gets 402 with the reason — they don't get charged for failed deliveries (verify failure means no settlement attempt; settle failure means the on-chain transfer didn't go through).

## Test it locally

The fastest loop is the [`examples/local-llm-agent`](../examples/local-llm-agent/) example — start the server with `PAYMENT_ENABLED=0` to verify the agent works, then flip to `PAYMENT_ENABLED=1` to see the 402 flow.

For a real on-chain test on Base Sepolia (free testnet USDC):

1. **Get a test wallet.** `openssl rand -hex 32` → use as `PRIVATE_KEY` for the Caller side; `viem` or any wallet tool can derive the address for the Publisher side.
2. **Fund the Caller wallet.** [Circle's Base Sepolia USDC faucet](https://faucet.circle.com/) — pick Base Sepolia, paste the Caller address, get test USDC.
3. **Set Publisher config:** `wallet=<your-publisher-address>`, `network=base-sepolia`, `priceUsdc=0.001`.
4. **Run a paid call:** `PRIVATE_KEY=0x... pnpm --filter @airlock-deploy/example-local-llm-agent client "hello"` — the client script wraps `fetch` with `@x402/fetch`, signs the payment, and retries automatically.
5. **Check settlement:** the response's `X-PAYMENT-RESPONSE` header contains the on-chain transaction hash; view it on [sepolia.basescan.org](https://sepolia.basescan.org/).

## Swap the Facilitator

Default `facilitatorUrl` is Coinbase's public Facilitator (free, hosted). To run your own:

```ts
{ ..., facilitatorUrl: 'https://my-facilitator.example.com' }
```

See the [x402 spec](https://www.x402.org/) for facilitator implementation requirements. v1 of `airlock-deploy` does not ship a self-hosted Facilitator binary.

## What `airlock-deploy` does NOT do

- **No platform fee.** We don't take a cut. Caller-Publisher payments are direct.
- **No KYC.** Wallets are wallets.
- **No payout management.** Funds land in your wallet on-chain; that's the end of our involvement.
- **No subscription / billing periods.** Each call is paid (or each balance top-up in per-token mode).

## Reference

- ADR: [`docs/adr/0005-x402-for-monetization.md`](./adr/0005-x402-for-monetization.md)
- Glossary terms: **Payment Middleware**, **Facilitator**, **Caller**, **Credit Balance** in [`CONTEXT.md`](../CONTEXT.md)
- x402 spec: <https://www.x402.org/>
- Coinbase Facilitator: <https://facilitator.x402.org/>
