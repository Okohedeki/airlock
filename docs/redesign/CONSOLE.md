# Operator Console — design

A local web cockpit for a running Worker. Same control as the CLI, plus the thing a
terminal can't give you: **watch the loop run step-by-step and intervene mid-run.**

## Principles
- **Localhost-first, zero deploy.** A static, no-build page (vanilla HTML/CSS/JS) served
  by the runtime at `GET /console`. It ships inside the same image; if `airlock up` runs,
  the console runs. No separate server, no build step, no CORS (same origin).
- **A thin client over the surface API.** The console invents no state — it reads the
  Worker's own HTTP API. Everything it shows is also available to scripts/curl.
- **Honest about the validation boundary.** Controls are *read-only* in the console:
  guards are edited in `worker.yaml` and re-validated through the one schema by the CLI
  (ADR-0020, C2). The console never writes the manifest.

## Architecture
```
browser ──HTTP──▶  /console            (the static page)
                   /v1/manifest         worker name/harness/models/controls/expose
                   /v1/chat/completions  stream=true → live StepEvent SSE (the Live tab)
                   /v1/runs, /v1/runs/{id}   run index + full step trace
                   /v1/runs/held             approval queue
                   /v1/runs/{id}/decision    approve/deny/skip/edit/override
                   /metrics                  live concurrency
```
Runs are listable because `EngineRunner.run` writes a per-run summary (status, tokens,
full step trace) under the tenant-first key `{tenant}/_runs/{run_id}` in the State Store
(C3) — so the console lists/inspects without scanning trace keys.

## Screens (v1 — single-worker cockpit)
| Tab | What it does | Backed by |
|---|---|---|
| **Overview** | worker identity, expose state, models/tools, live running/waiting | `/v1/manifest` + `/metrics` |
| **Live** | send a request, watch each `StepEvent` stream in as a colored card; see the final answer | streaming `/v1/chat/completions` |
| **Runs** | recent runs table → click for the full step timeline | `/v1/runs`, `/v1/runs/{id}` |
| **Approvals** | held-run queue with approve / deny / skip (edit/override via API) | `/v1/runs/held`, `/decision` |
| **Controls** | read-only view of active guards (max_steps, budgets, gates, approvals, routing) | `/v1/manifest` |

Step cards are color-coded by type (model/tool/final) and status (ok/blocked/killed/error),
showing tokens, latency, the tool + redacted args, and any stop reason — the same data the
SSE stream and the trace store carry (epic 05, redaction shared with epic 13).

## Using it
```bash
cd examples/live-demo && airlock up         # or: PORT=3000 python -m airlock_agent
open http://localhost:3000/console
```
The **Live** tab is the demo: paste a stub script (`say:` / `tool:` / `final:`), hit Run,
watch the loop. Trip an approval (`tool: send {…}`) and clear it from **Approvals**.

## Not in v1 (next)
- **Fleet tab** — versions/canary slider, variants, replica health, expose toggle — once
  the router (epic 09) runs as a live HTTP service the console can call. The router logic
  and its decisions already exist (`packages/cli/src/router`); this is wiring a read/-write
  API in front of it.
- **Tenants tab** — per-tenant usage/limits from `{tenant}/_usage` (epic 10).
- **Replay/fork buttons** on a run (epic 04) once those entry points are exposed on the surface.
- Auth on the console itself (it binds to localhost; expose it only behind your own auth).
