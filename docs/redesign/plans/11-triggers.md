# Epic 11 — Triggers (cron / webhook / event)

## Context
A worker should fire on a cron, webhook, or event — not only when someone calls it directly. This
turns the worker from a request/response service into something that also runs proactively, on the
operator's own hardware. No scheduling/trigger machinery exists today.

## Scope
- **Scheduled & event-triggered:** fire on cron, webhook, or event.

## Dependencies
09 (the running worker + router host the trigger endpoints/scheduler).

## Design (locked: built into runtime + router; signed webhooks + cron + event intake)
- **`triggers:` in `worker.yaml`** declares triggers; the runtime runs them self-contained:
  - **Cron:** an in-process, **timezone-aware** scheduler invokes the worker on schedule.
  - **Webhooks:** HTTP intake endpoints that **verify an HMAC / shared-secret signature** before
    starting a run (reject bad signatures).
  - **Events:** a generic event-intake endpoint the org's bus/queue can POST to.
- A trigger invocation creates a normal run through the engine (so all controls/observability/
  state apply) and can target a specific skill/tool.
- Runs on the operator's hardware (no external scheduler required); can integrate the org's event
  bus as a source.

## Key files
`triggers/` (scheduler + intake routes) in the runtime; signature verification; `worker.yaml`
`triggers` schema; wiring through the router (epic 09) for exposure.

## Open questions
- Cron persistence/missed-run policy across restarts (catch-up vs skip).
- Webhook signature scheme(s) to support (HMAC-SHA256 default; per-provider verifiers later).
- Event-intake payload → run-input mapping.

## Verification
- A cron trigger invokes the worker on schedule in the correct timezone.
- A correctly-signed webhook POST starts a run; a bad signature is rejected.
- An event POST to the intake endpoint starts a run with the mapped input.
