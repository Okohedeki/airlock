# `airlock` CLI reference

All commands are accessible via `npx -y @airlockhq/cli <command>` or a local install. Source lives at [`packages/cli/src/cli.ts`](../packages/cli/src/cli.ts); the platform-specific spawn logic is at [`packages/cli/src/exec.ts`](../packages/cli/src/exec.ts).

## Index

| Command | Purpose | Wraps |
|---|---|---|
| `init <name>` | Write `.airlock/config.toml` + a starter Recipe config | — |
| `doctor` | Validate the local config | — |
| `status` | Print the current project config (JSON) | — |
| `serve` | Wrap a local LLM HTTP endpoint with x402 + dashboard reporting | — |
| `dev` | Open a public Tunnel via cloudflared | `cloudflared tunnel` |
| `deploy` | Push the Agent to the Target | `wrangler deploy` / `fly deploy` |
| `delete` | Tear down the deployment | `wrangler delete` / `fly apps destroy` |
| `logs` | Stream live logs | `wrangler tail` / `fly logs` |
| `secret set` / `list` / `rm` | Manage Target secrets | `wrangler secret …` / `fly secrets …` |
| `domain add` / `rm` | Manage custom domains | `wrangler domains …` / `fly certs …` |
| `login` | GitHub device-flow auth to the dashboard backend | — |
| `logout` | Forget the stored CLI auth token | — |
| `whoami` | Print the GitHub account this CLI is logged in as | — |
| `sync` | Register this project with the dashboard backend | — |

---

## `init <name>`

Wraps the current project with airlock config and a starter Recipe.

```
airlock init <name> [-t|--target workers|fly] [--no-recipe]
```

- `<name>` — project name; written into the Recipe configs and used as the dashboard identifier.
- `--target` — `workers` or `fly`. Defaults to `fly`. The Target persists in `.airlock/config.toml` for the project's lifetime; we never auto-detect and never silently switch.
- `--no-recipe` — write only `.airlock/config.toml`, skip `wrangler.toml` / `fly.toml`.

Outputs the paths it wrote and next-steps hints.

## `doctor`

Re-runs the Zod / Pydantic schemas over `.airlock/config.toml` and reports findings.

```
airlock doctor
```

Exits non-zero if validation fails or the placeholder wallet is still in the config.

## `status`

```
airlock status
```

Prints the current project configuration as JSON. Useful for scripting:

```json
{
  "project": { "name": "my-agent", "target": "fly" },
  "payment": { "configured": true, "enabled": true, "mode": "flat", "network": "base", "wallet": "0x..." }
}
```

## `serve`

Wrap a locally-running LLM HTTP endpoint with x402 payment enforcement and (optionally) dashboard reporting.

```
airlock serve \
  [-u|--upstream URL] \
  [-p|--port PORT] \
  [--wallet ADDR] \
  [--price USDC] \
  [--no-payment] \
  [--backend URL] \
  [--project NAME]
```

- `--upstream` — local LLM URL (must speak OpenAI-compatible `POST /v1/chat/completions`). Default `http://localhost:8080` (llama.cpp's `llama-server` default).
- `--port` — port for the wrapper itself. Default `3000`.
- `--wallet` / `--price` — override `.airlock/config.toml` (or skip it entirely). Defaults price to `0.001` USDC.
- `--no-payment` — disable payment enforcement; everything passes through. Use for debugging the upstream forwarding path.
- `--backend` / `--project` — dashboard backend URL and project name for the reporter. If unset, `AIRLOCK_BACKEND` and `config.project.name` are read; `AIRLOCK_TOKEN` (or `~/.airlock/auth.json`) is required to report.

Exposes:
- `POST /v1/chat/completions` (OpenAI-compatible, payment-enforced)
- `POST /chat` (alias)
- `GET /` (info JSON)
- `GET /healthz`

Streams are forwarded as-is and force-enable `stream_options.include_usage` so per-token billing has a `total_tokens` to debit.

## `dev`

Open a public Tunnel to a locally-running Agent via cloudflared.

```
airlock dev [-p|--port PORT]
```

- `--port` — local port the Agent is listening on. Default `3000`.

Errors with an install hint if `cloudflared` isn't on PATH. The first-party `*.airlock.dev` tunnel server is deferred — see [`adr/0001-we-operate-the-hosted-dev-tunnel.md`](./adr/0001-we-operate-the-hosted-dev-tunnel.md).

## `deploy`

```
airlock deploy
```

Wraps the Target's deploy CLI. For `--target=workers`, runs `wrangler deploy`. For `--target=fly`, runs `fly deploy --app <project name>`. Inherits stdio so you see the real-time output.

## `delete`

```
airlock delete
```

Tears down the deployment at the Target. For workers: `wrangler delete`. For fly: `fly apps destroy <name> --yes`.

## `logs`

```
airlock logs
```

Streams live logs from the deployment. For workers: `wrangler tail`. For fly: `fly logs --app <name>`.

## `secret`

```
airlock secret set NAME=VALUE
airlock secret list
airlock secret rm NAME
```

Wraps `wrangler secret …` (workers; `set` is interactive — prompts for the value) or `fly secrets …` (fly; `set` takes `NAME=VALUE` directly). Secrets never touch airlock — they're piped straight to the Target CLI.

## `domain`

```
airlock domain add HOSTNAME
airlock domain rm HOSTNAME
```

Wraps `wrangler domains add/remove` (workers) or `fly certs add/remove` (fly).

## `login`

```
airlock login [--backend URL]
```

GitHub device-flow against the dashboard backend. Prints a user code and a URL; visit the URL, paste the code, and the CLI mints a token and stores it in `~/.airlock/auth.json`.

- `--backend` — defaults to `$AIRLOCK_DEPLOY_BACKEND` or `http://localhost:8787`.

## `logout`

```
airlock logout
```

Removes `~/.airlock/auth.json`. The token remains valid on the backend until revoked from the dashboard `/tokens` page.

## `whoami`

```
airlock whoami
```

Prints the GitHub account this CLI is logged in as. Exits non-zero if not logged in.

## `sync`

```
airlock sync
```

POSTs the current project (name + target from `.airlock/config.toml`) to the dashboard backend. Idempotent; safe to re-run. Re-syncing a previously-archived project revives it.

---

## Environment variables

| Var | Used by | Effect |
|---|---|---|
| `AIRLOCK_DEPLOY_BACKEND` | `login` default | Default `--backend` URL |
| `AIRLOCK_BACKEND` | `serve` reporter | Backend URL for dashboard reporting |
| `AIRLOCK_TOKEN` | `serve` reporter | CLI token (overrides `~/.airlock/auth.json`) |

## Exit codes

- `0` — success.
- `1` — runtime / validation error (with message on stderr).
- `2` — invalid CLI arguments.
- `127` — required Target binary (`wrangler` / `fly` / `cloudflared`) not on PATH. The error message includes the install URL.
