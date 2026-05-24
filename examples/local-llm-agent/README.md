# local-llm-agent

End-to-end demo: an Express server that forwards `POST /chat` to a locally-running [Ollama](https://ollama.com/) instance, optionally enforcing per-call x402 payment via `@airlockhq/payment-fly-node`.

> **For production** (llama.cpp on a Fly GPU machine with a real paywall), see [`docs/llama-cpp-on-fly.md`](../../docs/llama-cpp-on-fly.md). This example is the local-only dev loop.

## Prereqs

- Node ≥ 22, pnpm 10
- [Ollama](https://ollama.com/download) running locally on `http://localhost:11434`
- A small model pulled, e.g. `ollama pull llama3.2:1b`

## Run it

From the repo root:

```bash
pnpm install
pnpm --filter @airlockhq/example-local-llm-agent dev
```

Server starts on `http://localhost:3000`. Then in another terminal:

```bash
# Sanity check — root info endpoint
curl http://localhost:3000/ | jq

# Call the LLM (payment off by default → just works)
curl -s -X POST http://localhost:3000/chat \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"Say hello in 5 words."}]}' \
  | jq
```

You should see Ollama's response in the `message.content` field, plus a token count in `tokens` and an `X-Tokens-Used` response header.

## Turn on payment

Generate a placeholder wallet address (any 40-hex-char EVM address works for the off-chain 402 test):

```bash
PAYMENT_ENABLED=1 \
  PUBLISHER_WALLET=0x1234567890abcdef1234567890abcdef12345678 \
  PAYMENT_NETWORK=base-sepolia \
  PRICE_USDC=0.001 \
  pnpm --filter @airlockhq/example-local-llm-agent dev
```

Now the same curl call returns **HTTP 402** with the x402 PaymentRequired body — that's the unpaid path, and the handler never runs (Ollama isn't called, no tokens spent).

## Make a paid call

Use the bundled client script. It wraps `fetch` with `@x402/fetch` and signs the payment automatically:

```bash
# Unpaid mode — shows the 402 response and the requirements
pnpm --filter @airlockhq/example-local-llm-agent client "hello"

# Paid mode — needs a wallet funded with Base Sepolia USDC
PRIVATE_KEY=0x<your-test-private-key> \
  pnpm --filter @airlockhq/example-local-llm-agent client "Tell me a joke"
```

### Getting Base Sepolia test USDC

1. Generate a key: `openssl rand -hex 32` → prepend `0x` → use as `PRIVATE_KEY`
2. Derive the address (any wallet tool, or `viem`'s `privateKeyToAccount`)
3. Fund it from [Circle's Base Sepolia faucet](https://faucet.circle.com/) — pick **Base Sepolia**, paste the address, claim USDC

Use that address as the *Caller* (via `PRIVATE_KEY`). The server's `PUBLISHER_WALLET` is where the funds land — set it to a different address you control.

## What you should see on a successful paid call

```
paid call → http://localhost:3000/chat  signer=0xCallerAddress…
status: 200
settlement: tx=0xabc…  payer=0xCallerAddress…

response:
Here is a joke! Why did the agent cross the road? …

tokens reported: 87
```

Verify the on-chain transfer on [sepolia.basescan.org](https://sepolia.basescan.org/) using the `tx` hash.

## Environment

| Var | Default | What |
|---|---|---|
| `PORT` | `3000` | Server port |
| `OLLAMA_URL` | `http://localhost:11434` | Where Ollama is listening |
| `MODEL` | `llama3.2:1b` | Model name passed to Ollama |
| `PAYMENT_ENABLED` | `0` | Set to `1` to enforce x402 |
| `PUBLISHER_WALLET` | `0x000…0001` | EVM address that receives payments |
| `PAYMENT_NETWORK` | `base-sepolia` | `base-sepolia` (testnet) or `base` (mainnet) |
| `FACILITATOR_URL` | `https://facilitator.x402.org` | x402 facilitator |
| `PRICE_USDC` | `0.001` | Per-call price (flat mode) |
| `AGENT_URL` (client) | `http://localhost:3000/chat` | Where the client script POSTs |
| `PRIVATE_KEY` (client) | unset | If set, client signs and sends a paid call |

## Where to go from here

- [`docs/payment.md`](../../docs/payment.md) — full publisher quickstart, both Recipes
- [`docs/adr/0005-x402-for-monetization.md`](../../docs/adr/0005-x402-for-monetization.md) — why x402 over Stripe
- For a public URL (so other agents can reach this from the internet), point [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) or [`ngrok`](https://ngrok.com/) at `localhost:3000`. The first-party `airlock dev` tunnel server is on the roadmap but not in v1.
