# Epic 02 — Loop control & guards (+ mid-run intervention)

## Context
With the engine (01) emitting `StepEvent`s and consuming `ControlSignal`s, this epic adds the
operator controls that ride on it: cap runaway loops, enforce a token/$ budget *during* the run,
gate a tool by its actual arguments, and hold a sensitive step for human approval. These are the
features a front-of-agent gateway cannot do — they require sitting between steps.

## Scope
- **Operate any step:** pause / retry / resume / kill.
- **Loop guards:** `max_steps`; `budget{tokens, usd}` enforced mid-run.
- **Per-step tool gating:** allow/deny a tool call by matching its actual arguments.
- **Mid-run intervention:** hold a step for human approval before a sensitive tool fires (send /
  pay / write), with approve/deny, **edit tool args, inject guidance, override result/skip**.

## Dependencies
01 (engine + control seam), 04 (held-run state lives in the store), 05 (per-step cost for $
budgets via the price table).

## Design
- **Declarative `controls:` in `worker.yaml`:**
  - `max_steps: N`
  - `budget: { tokens: N, usd: N }` (usd computed from the per-model price table, epic 05)
  - `tools:` rules with **argument matchers** (e.g. `{ tool: db.write, when: "method == 'DELETE'",
    action: deny }`; `{ tool: payments.send, action: require_approval }`)
  - `approval: { timeout_s: N, on_timeout: deny }` (per-rule overridable)
- A **policy evaluator** (`engine/policy.py`) runs after each `StepEvent`/before each tool
  dispatch, returning a `ControlSignal` (continue / deny / require_approval / stop).
- **Mid-run intervention flow:**
  - A held run **parks in the state store** (epic 04) with its pending step.
  - Surfaced via **dashboard + Slack/Teams** notifications, both built on an **approval API**:
    `POST /runs/{id}/approve | deny | guide | edit` (+ `/runs?status=held` to list).
  - **Methods:** approve (fire as-is), deny (block → skip or abort per rule), **edit tool args**
    (mutate the pending call), **inject guidance** (append a steering message to context), and
    **override result / skip** (supply a result without running the tool).
  - **Auto-deny after timeout** (default; configurable per rule) so held runs don't pile up.
- **Guard-breach behavior:** default = **stop + return partial** with a machine-readable reason
  (e.g. `BUDGET_EXCEEDED`, `MAX_STEPS`); `hold-for-approval` (ask a human to extend) is an opt-in
  breach mode reusing the intervention channel.

## Key files
`engine/policy.py`; approval routes + held-run listing in `surface.py`; a Slack/Teams notifier
(`notify/`); `worker.yaml` `controls` schema (TS + Python); dashboard held-run UI (extends
`packages/server`).

## Open questions
- Argument-matcher expression language (reuse airlock-config's safe `when` evaluator vs a new one).
- Where Slack/Teams credentials live (worker.yaml secret refs vs env).
- Approver authorization (any operator vs roles) — ties to epic 10 auth.

## Verification
- A run exceeding the token/$ budget stops mid-run and returns partial + reason.
- A `DELETE`-argument tool call is blocked while a read passes (same tool, different args).
- A `require_approval` tool holds the run; approve resumes; **edit-args** and **inject-guidance**
  visibly change the outcome; **override/skip** returns without firing the tool.
- No response within the window → auto-deny.

---

# Build-ready spec (frozen contracts)

> Frozen 2026-06-04. Consumes C1 (`StepEvent`/`ControlSignal`/`ControlMode` from epic 01), C2 (one
> `worker.schema.json`, validated TS-side), C3 (`ScopedStore` held-run parking). This epic supplies
> the **real `control_source`** that epic 01's `run_loop` left as a no-op `continue` provider.
> Guards are **feature-derived per the C1 matrix** — see
> [ADR-0014 §"loop ownership is feature-derived"](../../adr/0014-airlock-owns-the-loop.md).

## `controls` block — added to `packages/cli/src/worker-schema/worker.schema.json` (C2)

ONE schema file; validated TS/CLI-side only (Python loads + trusts). Added under the worker object:

```jsonc
"controls": {
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "max_steps": { "type": "integer", "minimum": 1 },
    "budget": {
      "type": "object", "additionalProperties": false,
      "properties": { "tokens": { "type": "integer", "minimum": 1 },
                      "usd": { "type": "number", "exclusiveMinimum": 0 } }
    },
    "tool_gates": {
      "type": "array",
      "items": {
        "type": "object", "required": ["tool", "action"], "additionalProperties": false,
        "properties": {
          "tool": { "type": "string" },                       // exact name or glob (db.*)
          "when": { "type": "string" },                        // safe arg-matcher expr; omit = always
          "action": { "enum": ["allow", "deny"] }
        }
      }
    },
    "approvals": {
      "type": "array",
      "items": {
        "type": "object", "required": ["tool"], "additionalProperties": false,
        "properties": {
          "tool": { "type": "string" },
          "when": { "type": "string" },                        // optional: only hold when matched
          "timeout_s": { "type": "integer", "minimum": 1, "default": 300 },
          "on_timeout": { "enum": ["deny", "allow"], "default": "deny" }
        }
      }
    }
  }
}
```

Every producer/mutator of worker.yaml routes through the TS validator (C2) — the dashboard's
held-run UI does not write `controls` at runtime; it only writes held-run *state* (C3, below).

## `engine/policy.py` — the `control_source` (consumed by epic 01 `run_loop`)

```python
from airlock_agent.engine.events import StepEvent, StepType, StepStatus, ControlSignal
from airlock_agent.state.store import ScopedStore   # C3

class PolicyControlSource:
    """Built per run from worker.yaml `controls`. Engine calls evaluate() between steps and
    gate(pending) before each tool dispatch. Returns a ControlSignal (C1) — never raises."""
    def __init__(self, controls: dict, store: ScopedStore, run_id: str, control_mode): ...

    def gate(self, pending: "ToolCall") -> ControlSignal:        # WRAP-ok: tool-dispatch boundary
        # 1) tool_gates: first matching rule wins; deny → ControlSignal(action="kill"|"override"
        #    with override_result={"blocked": reason}) per breach mode.
        # 2) approvals: if a rule matches → park held run (C3) + ControlSignal(action="pause").
        ...

    def evaluate(self, ev: StepEvent) -> ControlSignal:          # between steps
        # max_steps: ev.index+1 >= max_steps → kill (reason=MAX_STEPS). WRAP-ok (step count only).
        # budget.tokens / budget.usd: OWN-ONLY — needs per-step model token counts
        #   (ev.prompt_tokens/completion_tokens, C1) + epic-05 price table for usd. On a WRAP
        #   binding these fields are 0/unknown, so budget guards are SKIPPED + a warning logged.
        ...
```

- **Argument matcher (`when`):** reuse airlock-config's existing safe `when` evaluator if one
  exists — **do NOT introduce `eval`/`exec`**. *Open item:* confirm a safe evaluator ships in
  `airlock-config` (sandboxed AST / comparison-only grammar); if absent, build a minimal
  comparison-only matcher (`==`, `!=`, `in`, `and`/`or` over `args.*`) — never raw Python eval.
- **Breach behavior:** default `stop + return partial` with machine reason (`BUDGET_EXCEEDED`,
  `MAX_STEPS`) via `ControlSignal(action="kill")`; opt-in `hold-for-approval` breach mode reuses the
  approval park path (asks a human to extend).

## Approval flow + held-run parking (C3)

- **Park:** on an `approvals` match, `gate()` writes `store.snapshot(f"_held/{run_id}", {pending,
  rule, deadline})` via the **scoped handle** — key resolves to `{tenant}/_held/run_x` (C3). Engine
  receives `pause`; the step is recorded with `StepStatus.BLOCKED` (C1).
- **Resume routes in `surface.py`** (one approval API; lists from `store.list_prefix("_held/")`):
  `GET /runs?status=held`, `POST /runs/{id}/approve|deny|edit|guide|override` →
  - `approve` → `ControlSignal(action="continue")` (fire as-is).
  - `deny` → `kill` (or skip per rule).
  - `edit` → `override(override_args=...)` — mutate pending call (C1 `override_args`).
  - `guide` → `override(guidance=...)` — inject steering message, then continue.
  - `override` / skip → `override(override_result=...)` — return a result without firing the tool.
- **Auto-deny on timeout:** a sweeper (or the resume path, lazily) checks `deadline`; expired held
  runs resolve per `on_timeout` (default `deny` → `kill`), so held runs never pile up.

## C1 matrix mapping (authoritative for this epic)

| Guard | Mechanism | `WRAP`-ok? |
|---|---|---|
| tool gating by arg (`tool_gates`) | tool-dispatch intercept | ✅ all harnesses |
| approval hold (`approvals`) | tool-dispatch intercept + park | ✅ all harnesses |
| `max_steps` | step-index count between steps | ✅ all harnesses |
| `budget.tokens` / `budget.usd` stop | per-step model token counts (`OWN`) | ❌ `OWN` only |

So tool-gate/approval/max_steps guards run on **all** harnesses (LangGraph, Claude, smolagents,
CrewAI, OpenAI Agents, custom); **budget-stop guards run on `OWN` harnesses only** (LangGraph,
Claude, custom-as-`Planner`) — on `WRAP` bindings budget is skipped with a logged warning, never a
false enforcement on `tokens == 0`.

## File-by-file

- **new** `engine/policy.py` — `PolicyControlSource` (`gate` + `evaluate` above); the breach-reason
  enum; the `when`-matcher adapter (wraps airlock-config's safe evaluator, open item).
- **new** `notify/` — `slack.py` / `teams.py` notifiers posting held-run links; a `Notifier`
  protocol so the surface fires on park. *Open item:* where Slack/Teams creds live —
  `worker.yaml` secret refs vs env (defer to epic 10 secrets; env for v1).
- **edit** `surface.py` — wire `PolicyControlSource` as `run_loop`'s `control_source` (replacing the
  epic-01 no-op); add the `/runs?status=held` + `approve|deny|edit|guide|override` routes; build the
  `ScopedStore` handle (C3, tenant `default` until epic 10) and pass it into the policy source.
- **schema** — the `controls` block in `worker.schema.json` (C2); CLI validate covers it.
- **dashboard** — held-run list + action UI extends `packages/server` (consumes the held routes).
- **edit** `engine/loop.py` — *no new code*: it already consults `control_source`; epic 02 only
  supplies a non-trivial source. (Confirms the epic-01 seam.)

## Verification → test layers (`docs/testing-e2e.md`)

- **L1** (`policy.py` unit): first-matching-gate-wins; `when` matcher allows `==`/`in`, **rejects
  `eval`-style input**; `max_steps` kills at the cap; budget on a `WRAP` step (tokens=0) is skipped
  not enforced; auto-deny resolves an expired held run.
- **L2** (stub harness, in-process ASGI): a `DELETE`-arg call is denied while a read on the **same
  tool** passes; a `require_approval` tool parks under `{tenant}/_held/run_x` and `approve` resumes;
  `edit`/`guide` change the outcome; `override`/skip returns without firing. **Subagent-automatable:
  a subagent plays the approver** hitting the held routes.
- **L2 (`OWN` only):** budget-stop returns partial + `BUDGET_EXCEEDED` mid-run on LangGraph/Claude;
  asserted **not** to run on smolagents/CrewAI/OpenAI Agents (C1 matrix). Tool-gate/approval/
  max_steps L2 tests run on **all** harnesses.
- **L4 (e2e):** real held run surfaces a Slack/Teams notification → approve from the link → run
  completes; timeout path auto-denies.
