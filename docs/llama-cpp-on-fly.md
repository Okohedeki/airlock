# llama.cpp on Fly with an x402 paywall

End-to-end walkthrough for the canonical airlock use case: a llama.cpp GGUF model running locally (for dev) and on a Fly GPU machine (for prod), exposed publicly with USDC-per-call payment enforcement and a dashboard that shows who paid.

> Latency note: `llama-server` on a laptop is fine for testing the wrapper; it is **not** fine for production traffic. The prod path below moves inference to a Fly GPU machine you own and pay for directly. We never hold prod traffic — see [`adr/0001-we-operate-the-hosted-dev-tunnel.md`](./adr/0001-we-operate-the-hosted-dev-tunnel.md).

## Prereqs

- A GGUF model file (e.g. `Meta-Llama-3.1-8B-Instruct.Q4_K_M.gguf`).
- Node 20+ and `pnpm` for the CLI.
- For dev: `llama.cpp` built locally. On macOS with Metal:
  ```bash
  git clone https://github.com/ggerganov/llama.cpp && cd llama.cpp
  make LLAMA_METAL=1 llama-server
  ```
- For prod: `flyctl` ([install](https://fly.io/docs/flyctl/install/)) and a Fly account with GPU access enabled.
- A wallet address you control on Base / Base Sepolia. (Free testnet USDC via [Circle's faucet](https://faucet.circle.com/) for testing.)

## Part 1 — Dev loop on your laptop

### 1.1 Run the model

```bash
./llama-server -m /path/to/model.gguf --port 8080 --host 127.0.0.1
```

`llama-server` exposes an OpenAI-compatible `POST /v1/chat/completions`. Confirm with:

```bash
curl -s http://localhost:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"say hi"}]}' | jq .choices[0].message
```

### 1.2 Wrap it with payment + reporting

```bash
# In any directory — `serve` doesn't need a config when you pass flags
npx -y @airlockhq/cli serve \
  --upstream http://localhost:8080 \
  --port 3000 \
  --no-payment
```

Visit `http://localhost:3000/` to confirm the wrapper is up. The `/v1/chat/completions` endpoint forwards to llama-server unchanged. With `--no-payment`, every caller goes through for free — this is the path for verifying that forwarding (including streaming) works before turning the paywall on.

Turn the paywall on:

```bash
npx -y @airlockhq/cli serve \
  --upstream http://localhost:8080 \
  --port 3000 \
  --wallet 0xYourWalletAddress \
  --price 0.001
```

Now unpaid callers get HTTP 402, paid callers settle USDC to your wallet on Base. See [`payment.md`](./payment.md) for the full per-token-billing flow if you'd rather charge by `total_tokens` than per-call.

### 1.3 Make it public

```bash
cloudflared tunnel --url http://localhost:3000
```

`cloudflared` prints a `https://<random>.trycloudflare.com` URL. That's a one-command public endpoint to the paywalled wrapper. Use it for sharing demos or paying yourself a test call from another machine. (Our own first-party tunnel server is deferred — for v0.x, cloudflared/ngrok is the path.)

### 1.4 (Optional) hook up the dashboard

```bash
npx -y @airlockhq/cli init my-agent --target=fly  # writes .airlock/config.toml
npx -y @airlockhq/cli login                       # GitHub device-flow
npx -y @airlockhq/cli sync                        # register with the dashboard
```

Re-run `serve` from the project directory; it picks up `AIRLOCK_TOKEN` from `~/.airlock/auth.json` and starts fire-and-forgetting each call to the dashboard. Open `http://localhost:8787/projects/<id>` to watch them land.

## Part 2 — Production on Fly with a GPU

Local `serve` works for iteration; for actual traffic you want a GPU box. This is the path that scales.

### 2.1 Project layout

```
my-agent/
  Dockerfile
  fly.toml
  server.py           # the thin HTTP entry point with the payment middleware
  requirements.txt
  .airlock/
    config.toml
```

You write the Dockerfile + thin HTTP entry point once. `airlock init` creates `.airlock/config.toml` and a starter `fly.toml`.

```bash
npx -y @airlockhq/cli init my-agent --target=fly
```

### 2.2 Dockerfile

This builds `llama-server` with CUDA and copies the GGUF into the image. The thin entry point is a FastAPI app that proxies to `llama-server` on `localhost:8080` and mounts the airlock Python middleware.

```dockerfile
FROM nvidia/cuda:12.4.0-devel-ubuntu22.04 AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
      git build-essential cmake ca-certificates curl python3 python3-pip && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /opt
RUN git clone --depth=1 https://github.com/ggerganov/llama.cpp
RUN cmake -S llama.cpp -B llama.cpp/build -DGGML_CUDA=ON && \
    cmake --build llama.cpp/build --config Release --target llama-server -j

FROM nvidia/cuda:12.4.0-runtime-ubuntu22.04
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip ca-certificates && \
    rm -rf /var/lib/apt/lists/*
COPY --from=build /opt/llama.cpp/build/bin/llama-server /usr/local/bin/llama-server
WORKDIR /app
COPY requirements.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt
COPY server.py ./
# Bake the model in. For larger weights, prefer a Fly volume — see 2.4.
COPY model.gguf /models/model.gguf
ENV MODEL_PATH=/models/model.gguf
EXPOSE 8000
CMD ["python3", "server.py"]
```

`requirements.txt`:

```
fastapi==0.115.0
uvicorn[standard]==0.30.0
httpx==0.27.0
airlock-payment>=0.1.0
```

### 2.3 `server.py` — the thin entry point

This is the one place a publisher writes a small wrapper: a containerized deployment needs an HTTP entry point that owns its own port, and the Payment Middleware mounts on that entry point. (Local dev doesn't need it — `airlock serve` is that entry point on a laptop.)

```python
import os, subprocess, asyncio
import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from airlock_payment import PaymentMiddleware, parse_payment_config

LLAMA_PORT = 8080
PORT = int(os.environ.get("PORT", "8000"))

# Launch llama-server alongside this process
subprocess.Popen([
    "llama-server",
    "-m", os.environ["MODEL_PATH"],
    "--port", str(LLAMA_PORT),
    "--host", "127.0.0.1",
    "-ngl", "99",  # offload all layers to GPU
])

config = parse_payment_config({
    "enabled": True,
    "mode": "per_token",
    "wallet": os.environ["WALLET"],
    "network": os.environ.get("NETWORK", "base"),
    "pricePerTokenUsdc": "0.000001",
    "minCreditBalanceUsdc": "0.10",
})

app = FastAPI()
app.add_middleware(PaymentMiddleware, config=config)

@app.post("/v1/chat/completions")
async def chat(req: Request):
    body = await req.body()
    async with httpx.AsyncClient(timeout=None) as client:
        upstream = await client.post(
            f"http://127.0.0.1:{LLAMA_PORT}/v1/chat/completions",
            content=body,
            headers={"content-type": "application/json"},
        )
        # Surface tokens_used so the middleware can debit the credit balance
        try:
            tokens = upstream.json().get("usage", {}).get("total_tokens", 0)
        except Exception:
            tokens = 0
        return JSONResponse(
            upstream.json(),
            status_code=upstream.status_code,
            headers={"X-Tokens-Used": str(tokens)},
        )

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT)
```

### 2.4 `fly.toml` for a GPU machine

```toml
app = "my-agent"
primary_region = "ord"

[build]
  dockerfile = "Dockerfile"

[[vm]]
  size = "a10"          # or "a100-40gb" / current Fly GPU SKU
  memory = "16gb"

[[services]]
  internal_port = 8000
  protocol = "tcp"
  auto_stop_machines = true
  auto_start_machines = true
  min_machines_running = 0

  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]
```

Large GGUF files (10GB+) are awkward to bake in. Use a Fly volume instead:

```bash
fly volumes create models --size 32 --region ord
# Mount in fly.toml under [[mounts]] source = "models", destination = "/models"
# Then `fly ssh sftp shell` and put your model.gguf into /models/
```

### 2.5 Set secrets and deploy

```bash
npx -y @airlockhq/cli secret set WALLET=0xYourWalletAddress
npx -y @airlockhq/cli secret set NETWORK=base   # or base-sepolia for testing
npx -y @airlockhq/cli doctor                    # validates .airlock/config.toml
npx -y @airlockhq/cli deploy                    # wraps `fly deploy`
npx -y @airlockhq/cli login                     # if not already
npx -y @airlockhq/cli sync                      # register with the dashboard
```

`fly deploy` prints the public hostname (`https://my-agent.fly.dev`). That's the paid endpoint.

## Part 3 — Pay a test call

On Base Sepolia (free testnet) — see [`examples/local-llm-agent/README.md`](../examples/local-llm-agent/README.md) for the full client snippet that signs an x402 payment with `viem` and retries with the `X-PAYMENT` header. Quick version:

```bash
# Fund a Caller wallet at https://faucet.circle.com/ (pick Base Sepolia)
PRIVATE_KEY=0x...your-caller-key \
PAID_URL=https://my-agent.fly.dev/v1/chat/completions \
pnpm --filter @airlockhq/example-local-llm-agent client "hello"
```

The response's `X-PAYMENT-RESPONSE` header contains the on-chain settlement hash; view it on [sepolia.basescan.org](https://sepolia.basescan.org/). The call also lands in the dashboard — open the project, click into the most-recent call, and you'll see request body, response body, tokens used, and the USDC amount.

## What to read next

- [`payment.md`](./payment.md) — full Payment Middleware reference (flat vs per-token, swapping the Facilitator, what the middleware does NOT do).
- [`cli.md`](./cli.md) — every command and flag, including `serve` options not covered here.
- [`adr/0005-x402-for-monetization.md`](./adr/0005-x402-for-monetization.md) — why x402 over Stripe.
