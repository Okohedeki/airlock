# Epic 03 — Mid-run routing & fallback

## Context
Inside one run, different steps have different needs: a heavy reasoning step wants a big model, a
cheap classification step a small one; and when a tool or model fails at step 3, the run should
swap to a backup and continue rather than 500 the whole request. Both require the engine to choose
the model per step and to catch step failures — only possible from inside the loop (epic 01).

## Scope
- **Mid-run model routing:** select the model per step from the worker's named bindings.
- **Mid-run fallback:** on a tool/model failure, retry then swap to a configured backup and
  continue.

## Dependencies
01 (engine + per-step hook), 07 (multiple named model bindings declared in `worker.yaml`).

## Design
- **`routing:` in `worker.yaml`** maps step role/type → a named model binding (e.g.
  `{ plan: gpt-big, classify: gpt-small, default: gpt-big }`). The engine (`engine/router.py`)
  resolves the model per step before each model call.
- **`fallback:`** declares ordered backups for models and tools (chains).
- **Failure handling (locked):** on a step failure (tool error/timeout or model error) →
  **retry N with backoff** (configurable) → if still failing, **switch to the fallback chain**
  (next model/tool) → else fail the run. Each retry/fallback is recorded as a `StepEvent` so it's
  visible in the stream/trace (epic 05).
- Model bindings come from epic 07 (`models:` block: name → provider/endpoint/env-key). Routing
  references them by name.

## Key files
`engine/router.py`; model-binding resolution in the engine/loader; `worker.yaml` `routing` +
`fallback` schema (TS + Python).

## Open questions
- How step "role/type" is determined for routing (explicit tags emitted by the binding vs the
  step type from the engine vs which tool is being called) — likely a small policy combining all
  three; finalize with epic 01's `StepEvent.type`.
- Whether fallback applies to whole-step retries only or also to streaming mid-token failures.

## Verification
- Steps of each configured role hit the configured model binding.
- A forced model failure retries N times (with backoff) then transparently continues on the
  backup; a forced tool failure falls back to the backup tool; the trace shows the retry/fallback
  steps.
