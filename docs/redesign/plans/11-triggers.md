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

---

# Build-ready spec (frozen contracts)

> Frozen 2026-06-04. **A trigger is just another request source.** It fires → constructs a
> request → enters the fleet-router pipeline at **stage 2 (`selectVersion`)** (C4) → flows through
> stages 2–5 to a worker → runs through the Loop Engine like any request (C1). There is **no
> separate routing path for triggers.** The `triggers` block lives in the one `worker.schema.json`
> (C2); cron state lives in the State Store (C3).

## `triggers/` in the runtime (new) — scheduler + intake routes

- **Cron scheduler** — an in-process, **timezone-correct** scheduler (each `cron[]` entry carries an
  IANA `timezone`; DST-aware next-fire computation). On fire it builds a request `{source:"cron",
  trigger_id, skill?, input}` and hands it to the **router pipeline at stage 2** (C4). Clock is
  **injectable** so L2 can advance virtual time without wall-clock waits.
- **Webhook intake routes** — HTTP endpoints mounted at each `webhook[].path`. On POST: verify the
  signature **before** anything else; on pass, construct `{source:"webhook", trigger_id, skill?,
  input: body}` → router stage 2. Bad signature → `401`, no run.
- **Event intake routes** — generic endpoint at each `event[].path` the org's bus/queue POSTs to.
  Payload is run through the declarative **input mapping** (below) to produce the run input →
  `{source:"event", ...}` → router stage 2.

All three paths converge on the **same** "construct request → router stage 2" entry, so controls,
observability, state, tenancy, and versioning (C1/C4) apply identically to triggered runs and
direct calls.

## `triggers` block in `worker.schema.json` (C2 — same one file)

```yaml
triggers:
  cron:                     # cron[]
    - id: nightly-report
      schedule: "0 2 * * *"           # 5-field cron
      timezone: America/Denver        # IANA tz; required (no implicit UTC)
      skill: report                   # optional target skill/tool
      catch_up: skip                  # skip | catch_up  (missed-run policy)
  webhook:                  # webhook[]
    - id: gh-push
      path: /triggers/gh-push
      signature: { scheme: hmac-sha256, secret_env: GH_WEBHOOK_SECRET, header: X-Signature-256 }
      skill: on_push
  event:                    # event[]
    - id: order-created
      path: /triggers/order-created
      skill: fulfil
      input:                          # declarative payload -> run-input mapping
        order_id: $.data.id
        items:    $.data.line_items
```

Block is optional. **Hard constraint (C2):** any epic-11 flow that **writes or updates
`worker.yaml`** (e.g. a future "register trigger" command) MUST route through the TS validator
(`validate.ts` over `worker.schema.json`) before the runtime re-reads — a manifest reaching the
runtime by any other path is unvalidated by design. The runtime trusts; it never re-validates.

## Cron persistence & missed-run policy (resolves open question, C3)

- Last successful fire time per trigger is persisted in the **State Store** via `scoped(tenant)`
  (or `_system/triggers/<worker>/<trigger_id>/last_fire` for system-level), tenant-first keys (C3).
- On restart the scheduler reads `last_fire` and applies the entry's `catch_up` policy:
  - **`skip`** (default) — advance to the next future fire; missed windows are dropped.
  - **`catch_up`** — replay each missed fire once, oldest-first, then resume normal schedule.
- Recommended default: **`skip`** (avoids thundering-herd replay after long downtime); `catch_up`
  is opt-in per trigger.

## Webhook signature verification (resolves open question)

- **Default scheme: `hmac-sha256`** over the raw request body using `secret_env`, compared
  constant-time against the configured `header`. Mismatch / missing signature → reject (`401`),
  **no run constructed.**
- Schema leaves room for **per-provider verifiers later** (`scheme: github | stripe | …`) behind the
  same `signature` shape — not built in v1.

## Event payload → run-input mapping (resolves open question)

- A **declarative mapping** in each `event[].input`: keys are run-input field names, values are
  JSONPath-style selectors (`$.data.id`) read from the POSTed payload. Missing required selectors →
  reject; the mapped object becomes the run input handed to the engine via router stage 2.

## File-by-file

- **new** `triggers/scheduler.ts|py` — timezone-correct cron, injectable clock, `last_fire` via C3.
- **new** `triggers/webhook.ts|py` — intake routes + signature verify (`hmac-sha256` default).
- **new** `triggers/event.ts|py` — intake routes + declarative input mapping.
- **new** `triggers/entry.ts|py` — shared "construct request → **router stage 2**" adapter (the
  single C4 entry point all three trigger kinds call).
- **edit** `router/pipeline.ts` (epic 09) — accept a trigger-sourced request at the **stage 2**
  entry; no new routing path, triggers are just another source.
- **schema** — add the `triggers` block to `packages/cli/src/worker-schema/worker.schema.json`
  (epic 07, C2); the **write-config-through-validator** constraint above.
- **state** — `last_fire`/missed-run keys via the State Store handle (epic 04, C3).

## Verification → test layers

- **L2 (hermetic, injectable clock):** advance virtual time → cron entry fires at the correct
  instant **in its IANA timezone** (incl. a DST boundary); `skip` vs `catch_up` on a simulated
  restart with a stale `last_fire`. Webhook: correct HMAC-SHA256 → run constructed; tampered body /
  bad sig → `401`, no run. Event: POST → input mapping produces the expected run input.
- **L3/L4:** a signed webhook POST and an event POST each enter router stage 2 and reach a worker
  run end-to-end (controls/observability/state apply, C1). A trigger-written `worker.yaml` is
  rejected by the validator when invalid (C2).
- **L5 (manual):** real-schedule wall-clock timing (a cron actually firing at 02:00 local) —
  out of automated scope; covered by the L2 injectable-clock test plus a manual smoke.
