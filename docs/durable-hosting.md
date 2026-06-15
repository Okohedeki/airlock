> ⚠️ **Historical — superseded by [`docs/redesign/`](./redesign/).** Deploy/expose is now one Docker image + the Fleet Router (redesign epic 09). Kept for reference.

# Durable hosting — a stable URL on **your own** account

`airlock up` gives you a public URL out of the box with **zero accounts**: an ephemeral
`*.trycloudflare.com` quick tunnel. That URL is great for a demo but **changes every run**, so it's
not something a Caller can depend on.

For a **durable, stable URL** you bring your **own** cloud account. airlock holds no keys and operates
no infrastructure on your behalf — it only runs the connector against credentials you provide. Two
bring-your-own paths:

| Path | Stable URL | What you bring | Status |
|---|---|---|---|
| **Cloudflare named tunnel** | your own domain (e.g. `agent.example.com`) | a Cloudflare account + domain + a tunnel connector token | ✅ supported |
| **Fly.io deploy** | `<app>.fly.dev` | a Fly account + `flyctl` + model secrets | ⚠️ experimental / unproven |

---

## Cloudflare named tunnel (bring-your-own)

The stable hostname is **yours** — a domain on your own Cloudflare account. airlock never owns the
domain and never sees your Cloudflare login; you create the tunnel in your dashboard and hand airlock
only the connector token.

### 1. Create the tunnel in your Cloudflare account

In the [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/): **Networks → Tunnels →
Create a tunnel** (type: *Cloudflared*). Name it, then:

- **Copy the connector token.** It's the long value in the install command Cloudflare shows
  (`cloudflared service install <TOKEN>`) — you only need the `<TOKEN>`.
- **Add a Public Hostname** for the tunnel: pick a subdomain on a domain you've added to Cloudflare
  (e.g. `agent.example.com`), and point its **Service** at `HTTP` → `localhost:3000` (match the port
  `airlock up` listens on — see `--port`).

### 2. Tell airlock about it

Add a `[tunnel]` block to `.airlock/config.toml` (the hostname is the one you just routed):

```toml
[tunnel]
durable  = true
provider = "cloudflare"
hostname = "agent.example.com"
```

Provide the connector token via the environment — **never put it in the config file** (it's a
secret):

```bash
export AIRLOCK_CF_TUNNEL_TOKEN="eyJ...your-connector-token..."
```

### 3. Verify, then go live

```bash
airlock doctor        # confirms hostname + AIRLOCK_CF_TUNNEL_TOKEN are set
airlock up --durable  # runs the agent + the named tunnel; serves your stable hostname
#   ✓ live (durable) at  https://agent.example.com
```

`airlock doctor` is the source of truth for "what am I missing" — with `durable = true` it reports
the exact key(s) you still need to provide.

You can also make durable the default for the project by leaving `durable = true` in the config and
just running `airlock up` (the `--durable` flag is for one-off opt-in).

### Notes

- **The port must match.** The Public Hostname's Service in your Cloudflare dashboard must point at
  the same `localhost:<port>` the agent runs on (`airlock up --port`). The token-based tunnel routes
  by the dashboard config, not by anything airlock passes.
- **airlock holds no Cloudflare keys.** The token is your account's; revoke it from your dashboard at
  any time.
- **`airlock dev` stays quick-tunnel only** — it's a dev surface. Durable is wired into `airlock up`,
  the self-host production path.

### Tuning + resilience

The named-tunnel connector takes optional tuning, via `[tunnel]` keys or `--cf-*` flags (flags win):

```toml
[tunnel]
durable  = true
hostname = "agent.example.com"
protocol = "quic"          # multiplexed transport (recommended)
region   = "us"            # pin the connector region to cut backbone RTT
metrics  = "localhost:9000" # expose cloudflared's metrics for saturation visibility
```

```bash
airlock up --durable --cf-protocol quic --cf-region us --cf-metrics localhost:9000
```

The durable connector is **supervised**: if `cloudflared` exits unexpectedly it reconnects with
backoff (the hostname is stable, so the same URL resumes) rather than leaving you down.

### Scaling to many requests (multi-box, one hostname)

A single box serves up to `AIRLOCK_MAX_CONCURRENCY` runs at once — set that to your **model's** real
parallel capacity (a remote provider's concurrency, or `llama-server --parallel N`), not higher, or
you just make every run slower. To go beyond one box, run `airlock up --durable` on **N machines with
the same `AIRLOCK_CF_TUNNEL_TOKEN`**: Cloudflare load-balances across all healthy connectors under the
one hostname (the ngrok "endpoint pool" equivalent, free). The surface is stateless per call, so any
box can serve any request — no session affinity. For health-checked pools, regional steering, or
failover, add **Cloudflare Load Balancing** (the `/metrics` endpoint and `/healthz` give it signals) —
that's the optional tier; replicas alone already balance. See [`scaling-cloudflare.md`](./scaling-cloudflare.md).

---

## Fly.io — experimental / unproven

> ⚠️ The Fly path is **scaffolded but not yet verified end-to-end** (no off-box deploy has been
> proven). Treat it as experimental. `airlock deploy` only wraps `fly deploy` — airlock operates no
> Fly infrastructure and you bring your own account.

What you must provide:

- A **Fly account** and the **`flyctl`** CLI installed (`brew install flyctl`), then `fly auth login`.
- **Model secrets** for a remote model (airlock never hosts inference — see
  [ADR-0008](./adr/0008-airlock-never-hosts-inference.md)): set them on the app with
  `airlock secret set OPENAI_API_BASE=… ` / `airlock secret set OPENAI_API_KEY=…`.
- For a **local-GGUF** image you must hand-edit the generated `Dockerfile` (build toolchain +
  memory sizing) — this is not automated. See [`llama-cpp-on-fly.md`](./llama-cpp-on-fly.md).

Flow once those are in place:

```bash
airlock secret set OPENAI_API_KEY=…   # on your Fly app
airlock doctor                        # warns that fly is BYO + unproven
airlock deploy                        # wraps `fly deploy --app <name>`
# then verify from OFF the box:
curl https://<app>.fly.dev/v1/chat/completions -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"ping"}]}'
```

If you hit issues, that's expected at this stage — the path is not yet a proven deliverable.
