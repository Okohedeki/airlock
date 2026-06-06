"""The Binding contract — how a Harness plugs into the Airlock Loop Engine.

Airlock owns the loop (ADR-0014). Instead of running the framework's opaque native
loop and returning only a final answer (the old `HarnessAdapter.run`), a Binding
exposes the *pieces* of an agent so the engine can drive it step by step:

- An **OWN** binding exposes a `planner()` + `tools()`; the engine makes the model
  calls and dispatches the tools itself → the full control set applies.
- A **WRAP** binding can't surrender its loop, so it exposes `run_wrapped(messages,
  dispatch)`; the engine passes a tool-dispatch shim so gating / approval / cache /
  sandbox still fire at the tool boundary and each tool call still emits a StepEvent
  → only the tool-centric control set applies.

This split is frozen contract C1 (feature → mechanism matrix). `AgentRunResult` is
kept as the engine's terminal return value; `steps` is now populated.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Callable, Protocol, runtime_checkable


@dataclass
class AgentRunResult:
    """What a run returns — the final answer plus usage and the step trace."""

    content: str
    units: int = 0
    unit_label: str = "tokens"
    prompt_tokens: int = 0
    completion_tokens: int = 0
    steps: list[Any] | None = None  # now populated by the engine (list[StepEvent])


class ControlMode(str, Enum):
    OWN = "own"  # airlock drives the model calls → full control set
    WRAP = "wrap"  # airlock intercepts tool dispatch only → tool-centric control


# A Tool is any callable; the engine dispatches it with keyword args.
Tool = Callable[..., Any]
# The dispatch shim the engine hands to WRAP bindings: name, args -> result.
Dispatch = Callable[[str, dict[str, Any]], Any]


@runtime_checkable
class Binding(Protocol):
    """A harness exposed as engine-drivable pieces. `control_mode` declares how much
    of the loop airlock can own for this harness (frozen contract C1)."""

    control_mode: ControlMode

    def tools(self) -> dict[str, Tool]:
        """name -> callable. Skills flatten to tools (epic 07)."""
        ...

    def planner(self) -> Any:  # returns a Planner; raises for WRAP bindings
        ...

    def assemble_prompt(self, messages: list[dict[str, Any]]) -> Any: ...

    def run_wrapped(self, messages: list[dict[str, Any]], dispatch: Dispatch) -> AgentRunResult:
        """WRAP bindings only: run the native loop, routing tool dispatch through
        `dispatch` so the engine still sees each tool call."""
        ...


# ---- message helpers (unchanged, still used by bindings) --------------------


def last_user_message(messages: list[dict[str, Any]]) -> str:
    """The last user turn — the simplest task extraction."""
    for m in reversed(messages):
        if m.get("role") == "user":
            return str(m.get("content", ""))
    return ""


def messages_to_task(messages: list[dict[str, Any]]) -> str:
    """Default task synthesis: the full transcript as text."""
    return "\n".join(f"{m.get('role', 'user')}: {m.get('content', '')}" for m in messages)


# ---- back-compat -------------------------------------------------------------
# Some callers (templates, the `serve()` helper, older tests) still pass an object
# with a `.run(messages) -> AgentRunResult` method. The engine treats such an object
# as a degraded single-step WRAP binding via `engine.loop.as_binding`.
@runtime_checkable
class HarnessAdapter(Protocol):
    def run(self, messages: list[dict[str, Any]]) -> AgentRunResult: ...
