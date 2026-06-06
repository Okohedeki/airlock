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

---

# Build-ready spec (frozen contracts C1 + C2)

> Frozen 2026-06-04. This is **in-loop, per-step model selection inside one worker's run** — it
> consumes the engine's `OWN`/`WRAP` seam (C1) and adds two blocks to the one `worker.schema.json`
> (C2). It is **distinct from the fleet router (C4)**, which routes *across* workers
> (version/variant). The fleet router picks which worker+variant serves a request; this router
> picks which model binding serves a step *within* that worker. No shared code, no shared schema
> block — `routing:`/`fallback:` here are per-step bindings, `variants:` (epic 12) is cross-worker.
> Do not redefine C1 types (`StepEvent`, `ControlSignal`, `ModelCall`, `ToolCall`, `Binding`,
> `ControlMode`) — consume them.

## C1 mapping (authoritative — gates the whole epic)

Per the C1 matrix: **mid-run MODEL routing and MODEL-failure fallback are `OWN`-only** — the engine
must own the model calls to pick the binding per step and to swap the model on failure. **TOOL-failure
fallback is `WRAP`-ok** — it lives in the engine's tool-dispatch shim, which fires for `WRAP`
bindings too. So `router.select_binding` is only invoked on the `OWN` path of `loop.py`; the tool
fallback wrapper is invoked wherever `dispatch` runs (both paths). A `routing:` block on a `WRAP`
worker is a `doctor` warning (no model ownership → routing is inert); a `fallback.tools` block is
honored everywhere.

## `engine/router.py` (new — in-loop, NOT the fleet router)

```python
from airlock_agent.engine.events import StepEvent, StepStatus, StepType
from airlock_agent.engine.planner import Action, ModelCall, ToolCall

# Role resolution (resolves open question): role = explicit planner tag, else step type,
# else tool name. Precedence: action.role (if the planner tags it) > StepType > tool name.
def step_role(action: Action) -> str:
    if isinstance(action, ModelCall):
        return getattr(action, "role", None) or "model"     # planner may tag e.g. "plan"/"classify"
    if isinstance(action, ToolCall):
        return action.name                                    # tool name is the routing signal
    return "default"

# routing: { plan: gpt-big, classify: gpt-small, default: gpt-big }
def select_binding(step_role: str, models_cfg: dict, routing_cfg: dict) -> str:
    return routing_cfg.get(step_role) or routing_cfg.get("default") or models_cfg["default"]

# fallback chain for a binding/tool name: ["gpt-big", "gpt-mid", "claude-haiku"]
def fallback_chain(name: str, fallback_cfg: dict, kind: str) -> list[str]:
    return [name, *fallback_cfg.get(kind, {}).get(name, [])]   # kind = "models" | "tools"
```

Both model dispatch and tool dispatch run through one **whole-step retry wrapper** (resolves the
streaming open question — see below):

```python
def with_fallback(emit, chain: list[str], invoke, *, retries: int, backoff):
    last_err = None
    for name in chain:                       # walk model/tool backups in order
        for attempt in range(retries + 1):
            try:
                return invoke(name)          # success → caller continues on `name`
            except Exception as e:           # model error/timeout OR tool error/timeout
                last_err = e
                emit(StepEvent(..., type=..., status=StepStatus.ERROR,
                               model=name, error=str(e)))   # each retry/fallback is a StepEvent
                backoff(attempt)
    raise last_err                           # chain exhausted → fail the run
```

## Open question resolved — streaming

**v1: whole-step retry only.** A model/tool failure retries/falls back at the *step* granularity
(re-issue the whole `ModelCall`/`ToolCall`). **Mid-token / mid-stream resume is out of v1** — a
stream that dies mid-token is treated as a failed step and retried whole. (Streaming transport is
epic 05; mid-token resume is a later epic once checkpoints from 04 land.)

## `routing` + `fallback` blocks — added to `worker.schema.json` (C2, the one file)

```yaml
routing:                       # role -> binding name (binding names come from models:, epic 07)
  plan: gpt-big
  classify: gpt-small
  default: gpt-big             # required if routing present; else falls through to models.default
fallback:
  retries: 2                   # whole-step retries before swapping (per chain entry)
  backoff: { kind: exponential, base_ms: 200, max_ms: 4000 }
  models:                      # binding name -> ordered model backups
    gpt-big:   [gpt-mid, claude-haiku]
  tools:                       # tool name -> ordered tool backups
    web_search: [web_search_lite]
```

Schema constraints (TS-validated only, Python trusts — C2): `routing.*` and every name in
`fallback.models` / its chains must reference a key in `models:`; `fallback.tools` names + chains
must reference declared tools/skills (epic 07). `retries >= 0`. Cross-references that don't resolve
are a `doctor` error. A `routing:` block with no `OWN` harness is a `doctor` **warning** (inert).

## File-by-file

- **new** `engine/router.py` — `step_role`, `select_binding`, `fallback_chain`, `with_fallback`
  (above). Pure functions over the manifest's `routing`/`fallback`/`models` dicts; no I/O.
- **edit** `engine/loop.py` (from epic 01) — on the `OWN` path, before each `ModelCall` dispatch,
  resolve `binding = select_binding(step_role(action), models, routing)` and run the call through
  `with_fallback(..., chain=fallback_chain(binding, fallback, "models"), retries=...)`; set
  `StepEvent.model = <binding actually used>`. The tool `dispatch` shim (fires on **both** OWN and
  WRAP) is wrapped with `with_fallback(..., chain=fallback_chain(tool, fallback, "tools"))`.
- **edit** `worker.schema.json` — add the `routing` + `fallback` sub-schemas to the existing
  top-level keys (already reserved in C2's block list, owner epic 03).
- **edit** `manifest.py` accessors (`loader.py` resolution path, C2) — add `routing()` /
  `fallback()` typed accessors; model-binding name → handle resolution stays in epic 07's
  `models()`. Router consumes names, loader/manifest resolves them to provider/endpoint/env_key.

## Verification → test layers (`docs/testing-e2e.md`)

- **L1** (pure): `select_binding` precedence (role hit → role; miss → routing.default → models.default);
  `step_role` precedence (planner tag > StepType > tool name); `fallback_chain` ordering; schema
  cross-ref validation (`doctor` rejects a `routing` target absent from `models:`).
- **L2 — C1-gated, `OWN` harness only.** Use a **stub `OWN` binding with forced failures** (a
  `Planner` that emits `ModelCall`s and a fault-injecting model handle): (a) steps tagged `plan`
  hit `gpt-big`, `classify` hit `gpt-small` (assert `StepEvent.model`); (b) forced model error
  retries N (with backoff) then continues on the backup binding — the run still finishes; the trace
  shows the ERROR `StepEvent`s then an OK step on the backup. **These tests run only on `OWN`
  harnesses** (LangGraph/Claude/custom-with-Planner).
- **L2 — all harnesses (`WRAP`-ok).** Stub tool that fails → engine `dispatch` falls back to the
  backup tool and continues; assert on both an `OWN` and a `WRAP` stub binding (tool fallback is
  matrix-universal). A `routing:` block on the `WRAP` stub is asserted **inert** (model unchanged).
- **L5 (manual):** real two-model routing (big/small) + a real provider-timeout fallback on a
  LangGraph worker.
