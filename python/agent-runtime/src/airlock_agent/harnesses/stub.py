"""Deterministic stub binding (OWN) — the test vehicle, no model required.

A scripted planner reads the last user message and drives a fixed sequence of
steps so functional tests can assert the StepEvent stream, control signals,
tool dispatch, and state without any external model. This is the binding the
hermetic L1/L2 tests run against.

Protocol used by tests (encoded in the user message, one directive per line):
    say: <text>            -> a MODEL step emitting <text>
    tool: <name> <json>    -> a ToolCall with json args
    final: <text>          -> finish with <text>
If no directives are present, it calls the "echo" tool then finishes.
"""

from __future__ import annotations

import json
from typing import Any

from ..adapter import AgentRunResult, ControlMode, last_user_message
from ..engine.events import StepEvent
from ..engine.planner import Action, Finish, ModelCall, ToolCall


def _parse_script(text: str) -> list[Action]:
    actions: list[Action] = []
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("say:"):
            actions.append(ModelCall(messages=[{"role": "user", "content": line[4:].strip()}]))
        elif line.startswith("tool:"):
            rest = line[5:].strip()
            name, _, raw = rest.partition(" ")
            try:
                args = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                args = {"input": raw}
            actions.append(ToolCall(name=name, args=args))
        elif line.startswith("final:"):
            actions.append(Finish(content=line[6:].strip()))
    if not actions:
        actions = [ToolCall(name="echo", args={"text": text}), Finish(content=f"echo: {text}")]
    if not any(isinstance(a, Finish) for a in actions):
        actions.append(Finish(content="done"))
    return actions


class _ScriptedPlanner:
    def __init__(self, actions: list[Action]) -> None:
        self._actions = actions

    def next_action(self, history: list[StepEvent]) -> Action:
        # One action per loop iteration, indexed by how many steps we've taken.
        i = len(history)
        if i < len(self._actions):
            return self._actions[i]
        return Finish(content="done")


def _echo(**kwargs: Any) -> Any:
    return kwargs.get("text") or kwargs.get("input") or kwargs


def echo_model_caller(name: str = "default"):
    """A deterministic 'model' for the stub: echoes the last message content and
    reports fixed token counts so cost/budget tests are reproducible. The `name`
    is baked into the output so model-switching tests can prove which binding ran."""

    from ..engine.loop import ModelResult

    def call(messages: list[dict[str, Any]]) -> ModelResult:
        content = last_user_message(messages) or (messages[-1].get("content", "") if messages else "")
        return ModelResult(content=f"[{name}] {content}", prompt_tokens=5, completion_tokens=5)

    return call


class StubBinding:
    """OWN binding with a scripted planner. Built per request (stateless)."""

    control_mode = ControlMode.OWN

    def __init__(self, messages: list[dict[str, Any]], tools: dict[str, Any] | None = None) -> None:
        self._actions = _parse_script(last_user_message(messages))
        self._tools = {"echo": _echo, **(tools or {})}

    def tools(self) -> dict[str, Any]:
        return self._tools

    def planner(self) -> _ScriptedPlanner:
        return _ScriptedPlanner(self._actions)

    def assemble_prompt(self, messages: list[dict[str, Any]]) -> Any:
        return messages

    def run_wrapped(self, messages, dispatch) -> AgentRunResult:  # pragma: no cover - OWN
        raise NotImplementedError("stub is an OWN binding")
