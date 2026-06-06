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

---

# Build-ready spec (frozen contract C1)

> Frozen 2026-06-04. The control surface is **feature-derived, not a uniform "owns the loop"**
> claim — see [ADR-0014 §"loop ownership is feature-derived"](../../adr/0014-airlock-owns-the-loop.md).
> This section is the contract Wave-2 epics (02/03/04/05/06) plan against; do not redefine these
> types downstream.

## Frozen types — `airlock_agent/engine/events.py`

```python
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Literal

class StepType(str, Enum):
    MODEL = "model"           # a model call (planner produced an action)
    TOOL_CALL = "tool_call"   # a tool was dispatched
    TOOL_RESULT = "tool_result"
    FINAL = "final"           # loop reached a final answer

class StepStatus(str, Enum):
    OK = "ok"
    ERROR = "error"
    BLOCKED = "blocked"       # held by a ControlSignal (e.g. approval)
    KILLED = "killed"

@dataclass
class StepEvent:
    index: int                       # 0-based, monotonic within a run
    type: StepType
    input: Any                       # redacted at the boundary by epic 13/05
    output: Any
    tokens: int = 0                  # 0 = unknown (e.g. tool-only step)
    prompt_tokens: int = 0
    completion_tokens: int = 0
    duration_ms: float = 0.0
    status: StepStatus = StepStatus.OK
    tool: str | None = None          # tool name when type is TOOL_* 
    model: str | None = None         # binding name when type is MODEL (epic 03)
    error: str | None = None

# Control consumed BETWEEN steps. override carries exactly one of args/result/guidance.
@dataclass
class ControlSignal:
    action: Literal["continue", "pause", "retry", "kill", "override"] = "continue"
    override_args: dict[str, Any] | None = None      # rewrite the pending tool call's args
    override_result: Any | None = None               # skip the tool, inject this result
    guidance: str | None = None                      # inject a system/user nudge, then continue
```

## Frozen protocols — `airlock_agent/engine/planner.py`

```python
from typing import Protocol, runtime_checkable, Any

# What a binding's planner returns each turn.
@dataclass
class ModelCall:  binding: str | None = None; messages: list[dict] = field(default_factory=list)
@dataclass
class ToolCall:   name: str; args: dict[str, Any]
@dataclass
class Finish:     content: str
Action = ModelCall | ToolCall | Finish

@runtime_checkable
class Planner(Protocol):
    def next_action(self, history: list[StepEvent]) -> Action: ...
```

## Frozen binding contract — replaces `HarnessAdapter` in `adapter.py`

A binding exposes the **pieces** of an agent (tools, planner, prompt assembly) instead of running
the native loop. It declares, per the C1 matrix, **how much of the loop airlock can own** for that
harness — which is what gates Wave-2 feature availability.

```python
class ControlMode(str, Enum):
    OWN  = "own"        # airlock drives the model calls → full control set
    WRAP = "wrap"       # airlock intercepts tool dispatch only → tool-centric control only

@runtime_checkable
class Binding(Protocol):
    control_mode: ControlMode
    def tools(self) -> dict[str, "Tool"]: ...        # name → callable (skills = tools, epic 07)
    def planner(self) -> Planner: ...                # raises if control_mode is WRAP
    def assemble_prompt(self, messages: list[dict]) -> Any: ...
    # WRAP bindings instead expose a tool-dispatch interceptor the engine wires into the
    # framework's native loop:
    def run_wrapped(self, messages: list[dict], dispatch) -> "AgentRunResult": ...
```

### The C1 feature → mechanism matrix (authoritative)

| Feature (epic) | Needs | Works on `WRAP`? |
|---|---|---|
| tool gating by arg (02), approval hold (02), tool-fallback (03), tool-result cache (04), sandbox (06) | tool-dispatch intercept | ✅ all harnesses |
| mid-run model routing (03), model-failure fallback (03), token/$ budget stop (02), checkpoint/resume + replay/fork (04), per-step model cost + live reasoning (05) | own the model calls (`OWN`) | ❌ `OWN`-mode harnesses only |

**Per-harness `control_mode` (default, may upgrade to `OWN` if extraction proves clean):**
LangGraph → `OWN`; Claude SDK → `OWN`; smolagents → `WRAP`; CrewAI → `WRAP`; OpenAI Agents →
`WRAP`; custom → `OWN` if the callable implements `Planner`, else `WRAP` (degraded/terminal).

## File-by-file

- **new** `engine/events.py`, `engine/planner.py` — the frozen types above.
- **new** `engine/loop.py` — `run_loop(binding, messages, control_source) -> AgentRunResult`:
  for `OWN`, the `assemble → ModelCall → parse → ToolCall|Finish → dispatch → StepEvent →
  consult ControlSignal → repeat` orchestrator; for `WRAP`, call `binding.run_wrapped(messages,
  dispatch)` where `dispatch` is the engine's tool-dispatch shim (so gating/approval/cache/sandbox
  still fire at the tool boundary and each tool call still emits a `StepEvent`).
- **rewrite** `harnesses/*.py` — each `drive()` becomes a `Binding`. LangGraph/Claude expose
  `planner()` + `tools()`; smolagents/CrewAI/OpenAI Agents implement `run_wrapped()` (extract
  tools, route dispatch through the shim). Keep `harnesses/__init__.py` `SPECS` but add
  `control_mode` alongside the existing `reentrant` flag.
- **rewrite** `adapter.py` — `Binding`/`ControlMode` protocol; keep `AgentRunResult` (engine still
  returns it as the terminal value; `steps` now populated).
- **edit** `loader.py` — `resolve_builder` also resolves a binding's tools+planner from the
  `worker.yaml` entry (model bindings/tools come from epic 07), not just `module:attr`.
- **edit** `surface.py` — drive `run_loop` instead of `adapter.run`; forward `StepEvent`s through
  the existing `_stream_run_native` pump (the sync-core + async-streaming-pump model is kept; the
  threadpool execution + ADR-0010 per-call rebuild + admission gate are unchanged).
- **`control_source`** — a no-op `ControlSignal.continue` provider in epic 01; epic 02 supplies the
  real policy/approval source.

## Open questions — resolved by C1
- *Extract-defs vs wrap-execution:* **both, declared per binding via `control_mode`** — `OWN`
  where defs extract cleanly, `WRAP` otherwise; degrade gracefully, no hard parity requirement.
- *Sync vs async loop:* **sync core + async streaming pump** (keep today's `_stream_run_native`
  model).
- *Custom-harness full control:* opt-in by implementing `Planner` → upgrades it to `OWN`.

## Verification → test layers (`docs/testing-e2e.md`)
- **L1/L2** (stub harness, in-process ASGI): `StepEvent` stream ordered for an `OWN` binding;
  `kill@N` stops before N+1; `pause`/`continue` round-trip; engine token totals == legacy
  `AgentRunResult`.
- **L2** per harness: each declared `OWN` harness emits model+tool steps; each `WRAP` harness emits
  a `StepEvent` per tool call. **Tests assert the matrix** — model/state-column assertions run
  only on `OWN` harnesses; tool-centric assertions run on all.
- **L5 (manual):** real-model step fidelity on each framework.
