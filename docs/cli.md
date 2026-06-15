# `airlock` CLI reference

Run via `npx -y @airlockhq/cli <command>` or a global install (`npm i -g @airlockhq/cli`). Source:
[`packages/cli/src/cli.ts`](../packages/cli/src/cli.ts).

> airlock is **payment-free and self-hosted** — it never hosts inference and there is no billing/
> x402 layer. You bring the model (local or a remote OpenAI-compatible endpoint); airlock runs the
> loop and exposes the worker.

## Index

| Command | Purpose |
|---|---|
| `init <name>` | Scaffold a project; `--detect [dir]` declares the harness folder's areas (harness, entrypoint, tools) |
| `migrate` | Scaffold a `worker.yaml` from a legacy `.airlock/config.toml` |
| `build` | Build a reproducible Docker image for this `worker.yaml` (validates first) |
| `doctor` | Validate the local config / `worker.yaml` and report issues |
| `status` | Print the current project configuration (JSON) |
| `up` | Run the worker locally and front it with a public Cloudflare URL |
| `dev` | Open a public Cloudflare tunnel to an already-running local worker |
| `control` | Open the **control plane** — operate the whole fleet from a local web UI |
| `deploy` | Run a multi-container fleet (N replicas) behind the router; optional canary |
| `promote` / `rollback` | Promote a version to 100%, or instantly drop the canary |
| `tunnel provision` | Auto-create a durable Cloudflare tunnel + DNS (needs `CF_API_TOKEN`) |
| `login` / `logout` / `whoami` / `sync` | Optional dashboard-backend auth + project registration |
| `delete` / `logs` / `secret` / `domain` | Legacy Target passthroughs (Cloudflare Workers) |

---

## Local project

### `init <name>`
Scaffold an airlock project.

```
airlock init <name> [--detect [dir]] [--self-host]
```

- `--detect [dir]` — scan a harness **folder** (default: this repo) and **declare** its areas — the
  agent **harness**, **entrypoint**, and **tools** — for you to confirm (the same scan surfaced in the
  control plane's **Detect** view). Point it at where the harness lives: `--detect ./src/agent`.
  It does **not** guess a model — your endpoint + keys aren't in the code; `migrate` scaffolds a model
  slot in `worker.yaml` for you to confirm.
- `--self-host` — target your own hardware (run with `airlock up`), no cloud recipe.

The redesign worker is one `worker.yaml`; if you have a legacy `.airlock/config.toml`, run `migrate`.

### `migrate`
```
airlock migrate [-o|--out worker.yaml]
```
Convert a legacy `.airlock/config.toml` into a schema-validated `worker.yaml` (the single operational
manifest the runtime boots from). The `models:` block is scaffolded as a **slot to confirm**
(`endpoint`/`model` left blank) — airlock never auto-guesses your model; you fill it in or set
`OPENAI_API_BASE`.

### `build`
```
airlock build [--base <image>] [--no-base-build]
```
Validate `worker.yaml`, generate a Dockerfile, and build a reproducible image (`docker build`).
Validation is the C2 gate — a malformed manifest never builds.

### `doctor`
```
airlock doctor
```
Validate the local config / `worker.yaml` against the schema and report findings. Non-zero on failure.

### `status`
```
airlock status
```
Print the current project configuration as JSON.

## Run

### `up`
Run the worker on your hardware and front it with a public URL. `--docker` runs the worker
**image** (`airlock build`) — the same artifact you ship to a fleet, so dev matches prod; without
it, `up` runs the worker as host Python (`python -m airlock_agent`) as a no-build fast path.

```
airlock up [-p|--port PORT] [--python BIN] [--no-tunnel] [--durable] [--hostname HOST]
           [--docker] [--image REF] [--mount] [--env-file PATH] [--profile NAME]
           [--max-concurrency N] [--max-queue N] [--queue-timeout S]
           [--cf-protocol quic|http2|auto] [--cf-region REGION] [--cf-metrics HOST:PORT]
```

- `--no-tunnel` — run locally only (`http://localhost:PORT`), no public URL.
- `--durable` — a **stable named tunnel on your own Cloudflare account** instead of the default
  ephemeral `*.trycloudflare.com` quick tunnel. Needs `AIRLOCK_CF_TUNNEL_TOKEN` (+ `--hostname` or a
  `[tunnel]` block). See **[durable hosting](./durable-hosting.md)**.
- `--docker` / `--image` / `--mount` / `--env-file` — run the worker in a container (needs `airlock build`).
- `--profile` — run a `worker.yaml` variant/profile (e.g. `internal` | `external`).
- `--max-concurrency` — the **model's** real parallel capacity (`AIRLOCK_MAX_CONCURRENCY`).
- `--cf-*` — tune the durable connector (also settable as `[tunnel]` keys).

Prints `✓ live at https://<rand>.trycloudflare.com` and serves the operator console at `/console`.
To scale beyond one box, run several replicas behind the router with `airlock deploy`.

### `dev`
```
airlock dev [-p|--port PORT]
```
Open a public Cloudflare quick tunnel to an already-running local worker on `PORT` (default `3000`).

### `control`
Open the **control plane** — a local web app to operate the whole fleet (no file-editing required).

```
airlock control [-p|--port 8788] [--root DIR] [--python BIN]
```

- `--root` — workspace directory to scan for `worker.yaml` projects (default: cwd).
- `--python` — python used to launch workers (respects a venv).

Serves at `http://localhost:8788`: a **fleet dashboard** (start/stop workers, live status/model/skills/
runs/cost), **Models** setup, **Skills** on/off (written to `worker.yaml` + applied live), a **Runs**
explorer, an **Approvals** governance queue, **Detect**, plus RBAC roles, environments, an append-only
**audit log**, and per-tenant cost & usage.

## Fleet & deploy

### `deploy`
```
airlock deploy [-r|--replicas 2] [-p|--port 8080] [--canary <image@pct>] [--expose] [--no-build]
```
Build the image and run **N worker replicas behind the router** (one ordered routing pipeline). With
`--canary image@pct`, send pct% of new sessions to a canary version; `--expose` opens a public tunnel
at the router. Control stays inside each worker; the router only decides which one handles a request.

### `promote` / `rollback`
```
airlock promote [-p|--port 8080]
airlock rollback [-p|--port 8080]
```
Promote the current version to 100% of traffic, or instantly drop the canary (stable wins). Stickiness
wins over canary — a live session never flips version mid-run.

### `tunnel provision`
```
airlock tunnel provision [-p|--port 3000] [--account ID] [--zone ID] [--name NAME]
```
Auto-create a durable Cloudflare tunnel + DNS via the Cloudflare API. Needs `CF_API_TOKEN`. After
provisioning, run `airlock up --durable --hostname <host>`.

## Dashboard backend (optional)

`login` / `logout` / `whoami` / `sync` authenticate this CLI to an airlock dashboard backend (GitHub
device flow) and register the project so it shows up there. `--backend` defaults to
`$AIRLOCK_DEPLOY_BACKEND` or `http://localhost:8787`. The token lives in `~/.airlock/auth.json`.

## Legacy Target passthroughs

`delete`, `logs`, and `secret` / `domain` shell out to the Cloudflare Workers CLI (`wrangler`) for
projects still deployed that way. The supported deploy path is now `deploy` (Docker fleet) +
`tunnel`/`up` for exposure.

---

## Environment variables

| Var | Used by | Effect |
|---|---|---|
| `AIRLOCK_PYTHON` | `up`, `control` | Python used to run `-m airlock_agent` |
| `AIRLOCK_CF_TUNNEL_TOKEN` | `up --durable` | Bring-your-own Cloudflare named-tunnel token |
| `CF_API_TOKEN` | `tunnel provision` | Cloudflare API token to create tunnel + DNS |
| `AIRLOCK_MAX_CONCURRENCY` / `AIRLOCK_MAX_QUEUE` / `AIRLOCK_MAX_WAIT_S` | runtime | Run-gate admission (the model's parallel capacity; queue depth; wait budget before `429`) |
| `OPENAI_API_BASE` / `OPENAI_API_KEY` | the model bindings | Your OpenAI-compatible endpoint + key — airlock never hosts inference |
| `AIRLOCK_DEPLOY_BACKEND` | `login` | Default dashboard backend URL |

## Exit codes

- `0` — success.
- `1` — runtime / validation error (message on stderr).
- `2` — invalid CLI arguments.
- `127` — a required binary (`cloudflared`, `docker`, `wrangler`) is not on PATH (message includes the install hint).
