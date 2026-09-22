# `airlock` CLI reference

Run via `npx -y @airlockhq/cli <command>` or a global install (`npm i -g @airlockhq/cli`). Source:
[`packages/cli/src/cli.ts`](../packages/cli/src/cli.ts).

> airlock is **payment-free and self-hosted** — it never hosts inference and there is no billing/
> x402 layer. You bring the model (local or a remote OpenAI-compatible endpoint); airlock runs the
> loop and exposes the worker.

## Index

| Command | Purpose |
|---|---|
| `init <name>` | Scaffold a project; `--detect` finds your harness + entrypoint |
| `migrate` | Scaffold a `worker.yaml` from a legacy `.airlock/config.toml` |
| `build` | Build a reproducible Docker image for this `worker.yaml` (validates first) |
| `doctor` | Validate the local config / `worker.yaml` and report issues |
| `status` | Print the current project configuration (JSON) |
| `up` | Publish a native worker through the saved Caddy relay profile |
| `control` | Open the **control plane** — operate the whole fleet from a local web UI |
| `deploy` | Run a multi-container fleet (N replicas) behind the router; optional canary |
| `promote` / `rollback` | Promote a version to 100%, or instantly drop the canary |
| `login` / `logout` / `whoami` / `sync` | Optional dashboard-backend auth + project registration |
| `delete` / `logs` / `secret` / `domain` | Legacy Target passthroughs (Cloudflare Workers) |

---

## Local project

### `init <name>`
Scaffold an airlock project.

```
airlock init <name> [--detect] [--self-host]
```

- `--detect` — scan this repo, detect the agent **harness + entrypoint**, and wire them up (the same
  scan surfaced in the control plane's **Detect** view).
- `--self-host` — target your own hardware (run with `airlock up`), no cloud recipe.

The redesign worker is one `worker.yaml`; if you have a legacy `.airlock/config.toml`, run `migrate`.

### `migrate`
```
airlock migrate [-o|--out worker.yaml]
```
Convert a legacy `.airlock/config.toml` into a schema-validated `worker.yaml` (the single operational
manifest the runtime boots from).

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
Start the native worker and publish it through your saved Caddy relay profile.

```sh
airlock up [-p|--port PORT] [--python BIN] [--relay PATH] [--no-tunnel]
           [--docker] [--image REF] [--mount] [--env-file PATH] [--profile NAME]
           [--max-concurrency N] [--max-queue N] [--queue-timeout S]
```

- `--relay` selects a profile; the default is `.airlock/relay.json`.
- `--no-tunnel` explicitly keeps the worker local for development.
- `--docker` / `--image` / `--mount` / `--env-file` optionally run in a container.
- `--profile` selects a worker.yaml profile. Public profiles must require caller authentication.
- `--max-concurrency` sets model concurrency (`AIRLOCK_MAX_CONCURRENCY`).

A verified launch prints the public API and console URL. Caller keys authorize
agent work; `X-Airlock-Operator-Token` separately authorizes administration.
Public startup requires `AIRLOCK_OPERATOR_TOKEN` and relay credentials. Failed
publication stops the worker. A missing profile is an error, not a local fallback.
On Windows, use `--python python` when `python3` is unavailable.
The native worker always binds to loopback behind the connector.

See [Caddy relay setup](caddy-relay.md) for infrastructure prerequisites and the
current Windows connector testing blocker. Service installers are not shipped.
The Cloudflare `dev`, `tunnel provision`, `--tunnel`, `--durable`, and `--cf-*`
interfaces have been removed. Fleet commands below are legacy features.

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

## Dashboard backend (optional)

`login` / `logout` / `whoami` / `sync` authenticate this CLI to an airlock dashboard backend (GitHub
device flow) and register the project so it shows up there. `--backend` defaults to
`$AIRLOCK_DEPLOY_BACKEND` or `http://localhost:8787`. The token lives in `~/.airlock/auth.json`.

## Legacy Target passthroughs

`delete`, `logs`, and `secret` / `domain` shell out to the Cloudflare Workers CLI (`wrangler`) for
projects still deployed that way. These historical cloud recipes are outside the native public-agent path.
Use `up` with a Caddy relay for the supported redesign.

---

## Environment variables

| Var | Used by | Effect |
|---|---|---|
| `AIRLOCK_RELAY_TOKEN` | `up` | Secret shared with the configured frps relay |
| `AIRLOCK_OPERATOR_TOKEN` | runtime | Separate operator authorization |
| `AIRLOCK_PYTHON` | `up`, `control` | Python used to run `-m airlock_agent` |
| `AIRLOCK_MAX_CONCURRENCY` / `AIRLOCK_MAX_QUEUE` / `AIRLOCK_MAX_WAIT_S` | runtime | Run-gate admission (the model's parallel capacity; queue depth; wait budget before `429`) |
| `OPENAI_API_BASE` / `OPENAI_API_KEY` | the model bindings | Your OpenAI-compatible endpoint + key — airlock never hosts inference |
| `AIRLOCK_DEPLOY_BACKEND` | `login` | Default dashboard backend URL |

## Exit codes

- `0` — success.
- `1` — runtime / validation error (message on stderr).
- `2` — invalid CLI arguments.
- `127` — a required binary (`docker`, `wrangler` for legacy commands) is not on PATH (message includes the install hint).
