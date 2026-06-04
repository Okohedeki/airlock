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
