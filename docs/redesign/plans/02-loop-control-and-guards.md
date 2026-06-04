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
