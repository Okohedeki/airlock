# Epic 01 — Airlock Loop Engine (keystone)

## Context
"Control the loop" — operate any step, stream steps live, gate tools by argument, enforce budgets
mid-run — is impossible while the harness runs its own opaque loop and airlock sees only the final
`AgentRunResult`. Today `HarnessAdapter.run(messages) → AgentRunResult`
(`python/agent-runtime/src/airlock_agent/adapter.py:15`) hands the whole run to the framework
(`agent.run()` / `graph.invoke()` / `crew.kickoff()` / `Runner.run_sync()` / `query()`), and
`AgentRunResult.steps` is never populated. This epic **inverts that contract**: airlock owns the
loop. It is the keystone — epics 02, 03, 05, 06, 13 (and 04's snapshots) all hang off the step
stream it produces.

## Scope
- A runtime loop owned by airlock that performs `model-call → tool-dispatch → repeat`.
- A uniform `StepEvent{index, type, input, output, tokens, duration, status}` emitted per step.
- A `ControlSignal{continue | pause | retry | kill | override(args | result | guidance)}` consumed
  between steps.
- Per-harness **bindings** so all five frameworks + custom run *through* the airlock loop.

**Non-goals:** the policies that consume control (epic 02), routing/fallback (03), persistence
(04), streaming transport (05), sandboxing (06). This epic provides the seam; others use it.

## Dependencies
00 (clean base). Pairs with 04 (snapshots) and 07 (manifest supplies tools/model bindings).

## Design (vs current code)
Replace the opaque adapter with an **engine + bindings** split:

- `airlock_agent/engine/` (new):
  - `loop.py` — the orchestrator loop: assemble prompt/context → call model (via the binding's
    model handle) → parse the planner's next action → if tool call, dispatch tool → record
    `StepEvent` → consult `ControlSignal` → repeat until final answer / kill / guard stop.
  - `events.py` — `StepEvent`, `ControlSignal`, step `type` enum (`model`, `tool_call`,
    `tool_result`, `final`).
  - `planner.py` — the `Planner` protocol a binding implements: `next_action(history) → Action`
    (`ModelCall | ToolCall | Finish`).
- `harnesses/*` rewritten as **bindings** that expose (a) the tool set, (b) a planner/policy,
  (c) prompt assembly — rather than running the native loop:
  - **LangGraph / Claude SDK** (native seams): drive node-by-node / consume the async-gen, mapping
    each yielded step to a `StepEvent`.
  - **smolagents / CrewAI / OpenAI Agents** (opaque): extract the framework's tool + agent/prompt
    definitions and run them under the airlock loop instead of `agent.run()`/`kickoff()`/
    `Runner.run_sync()`. Where a definition can't be cleanly extracted, **wrap the framework's
    tool-execution layer** so each tool call surfaces as a `StepEvent` and tool dispatch routes
    through the engine.
  - **custom**: a documented protocol — the publisher's callable either returns the final answer
    (degraded, single-step) or implements the `Planner`/tool interface for full control.
- Keep the threadpool execution model in `surface.py` (`run_in_threadpool`) and ADR-0010 per-call
  isolation (factory rebuild per request). The loop runs inside the existing admission gate.
- `loader.py` — extend to resolve a binding's tools + planner from the `worker.yaml` entry, not
  just a `module:attr`.

The central engineering risk is the opaque frameworks; the binding layer isolates per-framework
extraction so the engine stays uniform.

## Key files
New `airlock_agent/engine/{loop,events,planner}.py`; rewritten `harnesses/*.py` (bindings);
new `adapter.py` protocol (binding contract); `loader.py` (resolve tools/planner); minimal
`surface.py` wiring to drive the engine and forward `StepEvent`s.

## Open questions
- Exact tool/planner extraction strategy per opaque framework (extract-defs vs wrap-execution).
- Sync vs async loop (frameworks mix; threadpool today is sync — likely keep sync core with an
  async streaming pump as in `_stream_run_native`).
- Custom-harness opt-in surface for full control.

## Verification
- A run emits an ordered `StepEvent` stream for **each** harness (LangGraph, Claude, smolagents,
  CrewAI, OpenAI Agents, custom).
- `kill@N` stops before step N+1; `pause`/`continue` round-trips.
- Token totals from the engine match the legacy `AgentRunResult` totals for the same input.
