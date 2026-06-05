# Running a Worker in Docker (the reproducible path)

> **Docker is the decided direction** (`ADR-0012`, accepted). The "no Docker for v1" you
> may see is **archived/superseded** — it lives only in `MEMORY.md`'s pre-redesign history.
> Host `python3` is the dev convenience; **Docker is how you ship reproducibly.**

Different machines have different Python versions, tool dependencies, and harness
frameworks. `airlock build` pins all of that into one image so a Worker runs identically
everywhere — and the image digest *is* the version artifact (epic 08).

## The flow

```bash
cd examples/live-demo
airlock build                 # validate worker.yaml → build airlock/<name>:<contenthash>
airlock up --docker           # run the image: publish port + state volume + public tunnel
# dev shortcut (no rebuild on each edit):
airlock up --docker --mount   # mounts the project into the base image
```

- **`airlock build`** validates `worker.yaml` through the one schema (the CLI is the gate,
  ADR-0020), generates a `Dockerfile` `FROM airlockhq/airlock` that COPYs your project and
  `pip install -r requirements.txt`, and tags by a **content hash** of
  `worker.yaml` + `requirements.txt` → same manifest, same image (idempotent rebuild).
- **`airlock up --docker`** runs that image and opens the public Cloudflare URL the same way
  the host path does (the tunnel stays host-side — no creds in the image). `--image <ref>`
  runs a specific image; `--env-file` passes secrets.

### Persistent (non-ephemeral) public URL — bring your own Cloudflare

The default `*.trycloudflare.com` URL is **ephemeral** (it changes each run and dies with the
process). For a **stable** URL on your own domain, use a durable named tunnel with your own
Cloudflare account:

```bash
# one-time in your Cloudflare Zero Trust dashboard: create a Tunnel, copy its connector token,
# and route a Public Hostname (e.g. agent.yourdomain.com) to http://localhost:<port>
export AIRLOCK_CF_TUNNEL_TOKEN=<your connector token>
airlock up --docker --durable --hostname agent.yourdomain.com
```

airlock holds no Cloudflare keys — the token is yours and stays on your machine. Without
`--durable` you get the throwaway quick tunnel. (The same `--durable`/`--hostname` flags work
on the host path too.)

**Zero-interaction setup** (no dashboard, no sudo): put a Cloudflare **API token** (Account →
Cloudflare Tunnel:Edit + Zone → DNS:Edit) in `.env` as `CF_API_TOKEN`, then:

```bash
airlock tunnel provision --hostname agent.yourdomain.com   # creates the tunnel + DNS,
                                                            # writes AIRLOCK_CF_TUNNEL_TOKEN
airlock up --docker --durable --hostname agent.yourdomain.com
```

`airlock tunnel provision` creates (or reuses) the named tunnel, routes its ingress at your
local port, upserts the DNS CNAME, and saves the connector token to `.env` for you. The CLI
also auto-loads `.env`, so the token is picked up automatically.

## The control plane is unchanged

Containerizing changes *packaging*, not *control*. All 13 features stay driven by the same
surface — `worker.yaml` + the HTTP API + `/console` (reachable at
`http://localhost:<port>/console`):

| Feature | In a container |
|---|---|
| 01 loop · 05 observability · 13 io | pure Python, served on the published port — unchanged |
| 02 guards/approval · 10 tenancy · 11 triggers | unchanged; approvals/webhooks over the port |
| 06 sandbox | **stronger** — real rlimit/network isolation on Linux |
| 07 manifest | `worker.yaml` is the baked, content-addressed image (a worker, not an output) |
| 04 state/cache | unchanged — **persisted to a mounted volume** |

## Three plumbing accommodations (not control changes)

1. **State volume** — the SQLite State Store at `.airlock/state.db` is mounted
   (`-v $PWD/.airlock:/app/worker/.airlock`) so runs/sessions/cache/held-runs persist across
   `docker stop` / restart.
2. **Host-run models → `host.docker.internal`** — a model on the host (e.g. `llama-server`)
   is reachable from the container at `http://host.docker.internal:<port>`, not `127.0.0.1`.
   `airlock up --docker` adds `--add-host=host.docker.internal:host-gateway`; `airlock doctor`
   warns if a `models.*.endpoint` uses `127.0.0.1`/`localhost`. (Remote APIs work as-is —
   inference stays external, ADR-0019.)
3. **Secrets via env** — API keys and `HOOK_SECRET` pass through with `--env-file` or are
   forwarded from the host (`OPENAI_API_KEY`, `HOOK_SECRET`, `AIRLOCK_*`).

## Adding frameworks / tool deps

Put them in a `requirements.txt` next to `worker.yaml` (the examples already do this):

```
# examples/langgraph-agent/requirements.txt
langgraph>=0.2,<1
langchain-openai>=0.2,<1
```

`airlock build` installs them on top of the lean base. The base image
(`airlockhq/airlock`) ships only the engine + stub/openai bindings; frameworks come from
your per-project layer, so the base stays small and your image is fully pinned.

## Multi-container fleet (epics 09 / 08 / 12)

`airlock deploy` runs **N worker containers behind the live fleet router** (the router is a
real HTTP service that runs the frozen routing pipeline, then reverse-proxies to the chosen
container — control stays inside each worker):

```bash
cd examples/live-demo
airlock deploy --replicas 2 --port 8090        # build + 2 containers + router on :8090
# callers POST to http://localhost:8090/v1/chat/completions
curl http://localhost:8090/_control/status      # registry: workers, ports, health, rollout
airlock deploy --replicas 2 --canary airlock/live-demo:NEWTAG@10   # 10% of new sessions → canary
airlock promote --version NEWTAG                 # 100% → NEWTAG
airlock rollback                                 # drop the canary; stable wins
airlock deploy --replicas 2 --expose             # also open a public URL at the router
```

- **Load-balancing + sticky:** anonymous requests round-robin across healthy replicas; a
  session (`X-Airlock-Session`) pins to one replica (so resume/fork land where the state is).
- **Canary/rollback (08):** `--canary <image>@<pct>` registers a canary version; **stickiness
  wins over canary** — a live session never flips version. `promote`/`rollback` hit the
  router's control API.
- **Sharding (12):** a request's `X-Airlock-Capability` routes to a variant that declares it
  (capability hard-filter → cost → latency).
- v1 registry is in-memory in the `airlock deploy` process; a durable `_system/workers`
  registry in the State Store is the next step.

## Composition: skills on/off + variants/profiles

One `worker.yaml` can express **multiple agents** and **internal-vs-external** configs:

```yaml
skills:
  search: { tool: web_search, enabled: true }
  delete: { tool: rm, enabled: false }      # off — dropped from the loop; /skills/delete → 403
variants:
  internal: { expose: internal, auth: { scheme: none } }
  external: { expose: public,   auth: { scheme: api_key, required: true } }
  coder:    { capabilities: [code], models: { default: { model: gpt-4o } } }
```

- Pick a variant **per request** with `X-Airlock-Variant: external`, or **at deploy** with
  `airlock up --profile external`. Auth follows the active variant.
- A disabled skill's tool is removed from the loop and `/skills/<id>` returns 403 (404 unknown).
