# airlock-deploy-payment

x402 Payment Middleware for Python ASGI apps (Starlette / FastAPI). Companion to [`@airlock-deploy/payment-fly-node`](../../packages/payment-fly-node/) — same `PaymentConfig` schema so a `.airlock-deploy/config.toml` works under either Recipe.

## Install

```bash
pip install airlock-deploy-payment
# or, from this monorepo:
pip install -e ./python/payment-fly
```

Requires Python 3.9+.

## Use

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
    # ... your agent logic
    return {"message": "hi"}
```

Same flow as the Node middleware: missing/invalid `X-PAYMENT` → HTTP 402 with PaymentRequired body; verify → call handler → settle → attach `X-PAYMENT-RESPONSE`.

See [`docs/payment.md`](../../docs/payment.md) and [ADR-0005](../../docs/adr/0005-x402-for-monetization.md) for the full design.
