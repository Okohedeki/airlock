# Epic 05 — Step observability

## Context
The brief promises **live step streaming** (each reasoning step and tool call as it happens, not
just final tokens) and **per-step cost & latency** (which step and which tool spent the time and
money). Today only Tier-A/Tier-B token streaming exists (`surface.py`), with no step structure and
no cost. With the engine emitting `StepEvent`s (epic 01), this epic exposes them live and persists
them for the dashboard + replay.

## Scope
- **Live step streaming** of `StepEvent`s.
- **Per-step cost ($) & latency**, attributed to step and tool.
- Persisted, **redacted** step traces for the dashboard + replay; Prometheus + OpenTelemetry.

## Dependencies
01 (StepEvent stream), 04 (trace store + tool-result cache for raw values).

## Design
- **Live stream content (locked)** over **SSE + WebSocket**: step boundaries + type, model token
  deltas, tool name + **arguments (redacted per the epic-13 io rules)**, tool results + per-step
  **cost ($)** and **latency**. Extends the existing `_stream_run_native` pump.
- **Cost:** computed from the **per-model price table in `worker.yaml`** (epic 02/07) ×
  per-step tokens from the engine. Latency = engine step timing.
- **Trace privacy (locked):** persist **redacted** step traces (args/results redacted per the io
  rules) with a retention **TTL**; **raw** values live only in the access-controlled tool-result
  cache (epic 04) used for replay. No raw secrets/PII at rest in traces.
- **Metrics/tracing:** extend `/metrics` (Prometheus) with per-step counters/histograms; export
  **OpenTelemetry** spans per run/step/tool. Extend the `packages/server` dashboard with a per-run
  step timeline showing $ + latency per step.

## Key files
Engine emit hooks (01); `surface.py` streaming (SSE + new WebSocket); trace store (04); OTel
exporter; `packages/server/*` dashboard timeline; `/metrics` extension.

## Open questions
- WebSocket vs SSE as the primary live channel (ship both; pick a default).
- OTel span attributes/semantic-conventions for agent steps + tool calls.
- Dashboard auth/scoping for trace viewing (ties to epic 10).

## Verification
- A client watching a run sees each step as it happens (boundaries, deltas, tool name + redacted
  args, result, $ + latency).
- The dashboard shows a per-run redacted step timeline with per-step $ and latency.
- Prometheus scrape exposes per-step metrics; an OTel trace with step spans is exported.

---

# Build-ready spec (frozen contracts)

> Frozen 2026-06-04. Consumes C1 (`StepEvent`/`control_mode`), C2 (`worker.schema.json`),
> C3 (`ScopedStore` trace keys). **SSE is the primary live channel; WebSocket is a later add**
> (resolves the open question). This epic redefines none of those types — it *forwards, prices,
> persists, and renders* the C1 step stream.

## Channel decision (resolves open question)
**SSE primary, WebSocket later.** The runtime already has the `_stream_run_native` pump + queue +
`HEARTBEAT_S` keepalive (`surface.py:116`), and SSE rides the existing `text/event-stream` path
through Cloudflare without a protocol upgrade. WebSocket (bidirectional) only earns its place once
epic 02's interactive approve/override needs an inbound channel — deferred, not designed here.

## Live step frames — additive SSE event type (does not break OpenAI chunk stream)
The chat stream stays OpenAI-shaped; step observability rides **named SSE events** (`event: step`)
interleaved with the existing `data:` content chunks, so a plain OpenAI client ignores them and an
airlock dashboard subscribes to them. One frame per `StepEvent`, REDACTED at the boundary:

```
event: step
data: {"index":3,"type":"tool_call","tool":"search","args":{"q":"«redacted»"},
       "model":null,"status":"ok","duration_ms":812.4,"cost_usd":0.0,
       "prompt_tokens":0,"completion_tokens":0}
event: step
data: {"index":4,"type":"model","model":"claude","status":"ok","duration_ms":1840.1,
       "prompt_tokens":1320,"completion_tokens":210,"cost_usd":0.00488}
```

- Fields are the C1 `StepEvent` shape (`index/type/tool/model/status/duration_ms/prompt_tokens/
  completion_tokens`) + a derived `cost_usd`. `args`/`output` are redacted via the **shared epic-13
  io redactor** (see dependency) before they ever hit the wire or the store.
- Tool steps (`tool_call`/`tool_result`) carry `duration_ms` on **all** harnesses (WRAP-ok). Model
  steps carry `prompt_tokens`/`completion_tokens`/`cost_usd` **only on `OWN`** harnesses (C1: model
  token counts per step require owning the model calls). On `WRAP`, model-step cost fields are
  `null` and the frame is annotated `"cost_basis":"unavailable_wrap"`.

## Per-step cost — `pricing` block in `worker.schema.json` (C2)
A price table maps **model binding → $/token**, validated TS-side with the rest of the schema:

```jsonc
"pricing": {
  "type": "object",
  "description": "Per-model-binding price table; cost = tokens × rate, attributed per step.",
  "properties": {
    "currency": { "type": "string", "default": "USD" },
    "models": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "properties": {
          "input_per_1k":  { "type": "number" },   // $ per 1k prompt tokens
          "output_per_1k": { "type": "number" }    // $ per 1k completion tokens
        },
        "required": ["input_per_1k", "output_per_1k"]
      }
    }
  }
}
```

Cost is attributed per step: `cost_usd = prompt_tokens/1000×input_per_1k +
completion_tokens/1000×output_per_1k`, keyed by `StepEvent.model` (the binding name, C1). Unknown
binding or missing rate → `cost_usd=null` + a `pricing_missing` metric increment (never fabricate a
price). **C1 matrix:** per-step model cost is `OWN`-only; tool latency is all-harness.

## Persisted redacted step traces — C3 trace store + re-homed reporter
- **Keys (C3, via `scoped(tenant)`):** the engine persists each redacted step under
  `{tenant}/{session}/{run}/trace/{step}` — `kind = "trace"`, `id = step index` — using
  `scoped.snapshot(rest, redacted_event)`. Raw args/results are **never** in the trace; they live
  only in epic-04's access-controlled tool-result cache (`{tenant}/{session}/cache/{tool_hash}`)
  for replay. Trace TTL comes from `worker.yaml` (reuse epic-04 `state` retention).
- **Re-homing the DORMANT inspect store:** call-reporting used to flow *payment middleware →
  `POST /api/inspect` → `recordInspectCall` → `inspect_calls`* (`db.ts:104,326`,
  `server.ts:232`). Epic 00 removed the payment middleware, orphaning that reporter. It re-homes
  into the **runtime**: the engine's step emit-hook (epic 01) is now the reporter — it writes
  redacted traces to the C3 trace store, and a thin **trace-push** (runtime → server) replaces the
  old per-call POST. Flow becomes **runtime emit-hook → C3 trace store → dashboard renders**. The
  legacy per-call summary (`inspect_calls`: caller/status/tokens) is preserved as a **run-level
  rollup row** so existing dashboard stats keep working; the new per-step detail is the trace.

## Metrics + tracing
- **Prometheus `/metrics`** — extend the existing handler (`surface.py:253`, today gate-stats only)
  to emit, alongside gate saturation: `airlock_steps_total{harness,type,status}` (counter),
  `airlock_step_duration_seconds{harness,type,tool}` (histogram), `airlock_step_tokens_total{kind}`
  (counter; `kind∈{prompt,completion}`), `airlock_step_cost_usd_total{model}` (counter, `OWN`
  only), `airlock_pricing_missing_total{model}` (counter). Switch the handler to the Prometheus text
  exposition format (keep the JSON gate view at `/`).
- **OpenTelemetry** — one span per run, child span per step (`span.kind=INTERNAL`), tool spans
  nested under their step. Attributes: `airlock.step.index/type/status`, `airlock.tool.name`,
  `airlock.model.binding`, `airlock.step.cost_usd`, `airlock.tenant`. **Open item:** finalize the
  semantic-convention names for agent steps + tool calls (align to OTel GenAI conventions if/when
  stable) — keep them under the `airlock.*` namespace until then.

## Dashboard — per-run redacted step timeline
Extend `packages/server` to render the trace, not just the legacy call list:
- **db.ts** — new `run_traces` table `(id, project_id, run_id, session, tenant, step_index, type,
  tool, model, status, duration_ms, prompt_tokens, completion_tokens, cost_usd, redacted_args,
  redacted_result, timestamp)` + index `(project_id, run_id, step_index)`; `recordTrace(...)` and
  `listRunTrace(projectId, runId)`. Keep `inspect_calls` as the run-level rollup (re-homing above).
- **server.ts** — receive trace-push from the runtime (replaces `/api/inspect`'s per-call role; the
  runtime is the writer now). Scope reads by tenant (epic 10 / C4 dashboard scoping).
- **pages.ts** — a `runTimelinePage(...)` mirroring `callDetailPage` (`pages.ts:163`): one row per
  step showing index, type badge, tool/model, **$ (`cost_usd`)** and **latency (`duration_ms`)**,
  redacted args/result in `<pre class="body-pre">`. Reuse `.stats-grid` for run totals (total $,
  total latency, step count).

## File-by-file
- **edit** `engine/loop.py` (epic 01) — after each `StepEvent`, (a) price it via the `pricing`
  table, (b) redact via the epic-13 io redactor, (c) `scoped.snapshot("trace/{index}", ...)`,
  (d) hand the frame to the surface pump + metrics/OTel recorders. `OWN`-only fields stay `null` on
  `WRAP`.
- **edit** `surface.py` — extend `_stream_run_native` to also emit `event: step` frames from the
  queue (the pump already multiplexes a queue → SSE); extend `/metrics` to Prometheus text format;
  add the OTel span wiring around the run.
- **new** `airlock_agent/observability/{pricing.py (price table loader + cost calc), otel.py
  (span exporter), metrics.py (Prometheus registry)}`.
- **new** trace-push client in the runtime (runtime → server) + server receiver.
- **schema** — `pricing` block in `worker.schema.json` (C2).
- **edit** `packages/server/src/{db.ts (run_traces + helpers), server.ts (trace receiver, tenant
  scope), pages.ts (runTimelinePage)}`.

## Dependencies (note)
- **Epic 13 (io/ redaction):** the redactor is **shared** — epic 05 calls it at the trace boundary;
  it is NOT defined here. If epic 13 lands after, gate trace persistence behind a stub redactor.
- **Epic 01:** the emit-hook seam. **Epic 04:** trace TTL + raw-value cache. **Epic 10/C4:**
  dashboard tenant scoping.

## Verification → test layers (`docs/testing-e2e.md`)
- **L1:** cost calc (`tokens × rate`) exact for a known `pricing` table; unknown binding →
  `cost_usd=null` + `pricing_missing` increment; redactor invoked before any `snapshot`/SSE write
  (no raw arg escapes).
- **L2 (in-process ASGI):** a subscriber sees `event: step` frames in order with boundaries, type,
  tool name + redacted args, result, $ + latency; trace rows land under
  `{tenant}/{session}/{run}/trace/{step}`; `/metrics` exposes the new series; an OTel span tree
  (run→step→tool) is exported to an in-memory collector.
- **L2 per harness — asserts the C1 matrix:** **model-cost** assertions run **only on `OWN`**
  harnesses (LangGraph, Claude SDK; custom-if-Planner) — they must carry per-step `cost_usd` +
  token counts. **Tool-latency + stream-boundary** assertions run on **all** (incl. WRAP:
  smolagents, CrewAI, OpenAI Agents) — `duration_ms` present per tool step; WRAP model steps carry
  `cost_basis:"unavailable_wrap"`, never a fabricated cost.
- **L5 (manual):** real-model run renders a per-step $/latency timeline on the dashboard.
