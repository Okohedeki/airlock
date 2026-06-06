"""OpenAI-compatible binding (OWN) — a real tool-calling loop airlock owns.

Works against any OpenAI-compatible `/v1/chat/completions` endpoint (OpenAI,
llama-server, vLLM, the mock model server in tests). The engine makes the model
calls (so epic-03 routing and epic-05 per-step cost intercept them); this binding's
planner just reads the last model output from history and decides the next action:
emit the model's tool_calls as ToolCalls, or Finish when the model returns content.

Model bindings come from worker.yaml `models:`; tools from worker.yaml `tools:`.
"""

from __future__ import annotations

import inspect
import json
import os
import urllib.request
from typing import Any, Callable

from ..adapter import AgentRunResult, ControlMode
from ..engine.events import StepEvent, StepType
from ..engine.loop import ModelResult
from ..engine.planner import Action, Finish, ModelCall, ToolCall


_PY_TO_JSON = {int: "integer", float: "number", bool: "boolean", str: "string"}


def build_tools_schema(tools: dict[str, Callable]) -> list[dict]:
    """Introspect tool callables into OpenAI function-tool schemas so the model can
    emit tool_calls. Types come from annotations; the one-line docstring is the
    description. (Epic 13 can later override with the descriptor's typed schema.)"""
    out: list[dict] = []
    for name, fn in tools.items():
        props: dict[str, Any] = {}
        required: list[str] = []
        try:
            for pname, p in inspect.signature(fn).parameters.items():
                if p.kind in (p.VAR_KEYWORD, p.VAR_POSITIONAL):
                    continue
                props[pname] = {"type": _PY_TO_JSON.get(p.annotation, "string")}
                if p.default is inspect.Parameter.empty:
                    required.append(pname)
        except (ValueError, TypeError):
            pass
        desc = (inspect.getdoc(fn) or name).strip().splitlines()[0][:200]
        out.append({"type": "function", "function": {
            "name": name, "description": desc,
            "parameters": {"type": "object", "properties": props, "required": required}}})
    return out


def http_model_caller(endpoint: str, model: str, env_key: str = "OPENAI_API_KEY",
                      tools_schema: list[dict] | None = None) -> Callable:
    """Build a ModelCaller that POSTs to an OpenAI-compatible chat endpoint."""

    def call(messages: list[dict[str, Any]]) -> ModelResult:
        payload: dict[str, Any] = {"model": model, "messages": messages}
        if tools_schema:
            payload["tools"] = tools_schema
        body = json.dumps(payload).encode()
        headers = {"Content-Type": "application/json"}
        key = os.environ.get(env_key)
        if key:
            headers["Authorization"] = f"Bearer {key}"
        req = urllib.request.Request(endpoint, data=body, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode())
        choice = (data.get("choices") or [{}])[0]
        msg = choice.get("message", {})
        usage = data.get("usage", {})
        return ModelResult(
            content=msg.get("content") or "",
            prompt_tokens=usage.get("prompt_tokens", 0),
            completion_tokens=usage.get("completion_tokens", 0),
            data=msg,  # the full assistant message (content + tool_calls)
            model=data.get("model") or model,  # what actually served (for the trace)
        )

    return call


class _OpenAIPlanner:
    """Reads the last MODEL step's assistant message and turns tool_calls into
    ToolCalls (one per loop), or Finishes when the model returns plain content."""

    def __init__(self, messages: list[dict[str, Any]]) -> None:
        self._base = list(messages)

    def next_action(self, history: list[StepEvent]) -> Action:
        last_model = next((e for e in reversed(history) if e.type == StepType.MODEL), None)
        if last_model is None:
            return ModelCall(messages=self._base)
        msg = last_model.output if isinstance(last_model.output, dict) else {"content": last_model.output}
        tool_calls = msg.get("tool_calls") or []
        # Has the most recent tool_call already been answered by a tool result after it?
        pending = _next_unanswered_toolcall(history)
        if pending is not None:
            name, args = pending
            return ToolCall(name=name, args=args)
        if tool_calls and not _all_answered(history, tool_calls):
            name, args = _first_unanswered(history, tool_calls)
            return ToolCall(name=name, args=args)
        if msg.get("content"):
            return Finish(content=str(msg["content"]))
        # Model asked for tools we already ran → ask it again with the results.
        return ModelCall(messages=self._base + _replay(history))


def _decode_args(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    try:
        return json.loads(raw) if raw else {}
    except (json.JSONDecodeError, TypeError):
        return {"input": raw}


def _toolcalls_in(history: list[StepEvent]) -> list[tuple[str, dict]]:
    out = []
    for e in history:
        if e.type == StepType.MODEL and isinstance(e.output, dict):
            for tc in e.output.get("tool_calls") or []:
                fn = tc.get("function", {})
                out.append((fn.get("name", ""), _decode_args(fn.get("arguments"))))
    return out


def _answered_count(history: list[StepEvent]) -> int:
    return sum(1 for e in history if e.type == StepType.TOOL_RESULT)


def _next_unanswered_toolcall(history):
    calls = _toolcalls_in(history)
    answered = _answered_count(history)
    if answered < len(calls):
        return calls[answered]
    return None


def _all_answered(history, tool_calls):
    return _answered_count(history) >= len(_toolcalls_in(history))


def _first_unanswered(history, tool_calls):
    return _toolcalls_in(history)[_answered_count(history)]


def _replay(history):
    """Feed tool results back to the model as tool messages for the next turn."""
    msgs = []
    for e in history:
        if e.type == StepType.TOOL_RESULT:
            msgs.append({"role": "tool", "name": e.tool, "content": json.dumps(e.output)})
    return msgs


class OpenAIBinding:
    control_mode = ControlMode.OWN

    def __init__(self, messages: list[dict[str, Any]], tools: dict[str, Any] | None = None) -> None:
        self._messages = messages
        self._tools = tools or {}

    def tools(self) -> dict[str, Any]:
        return self._tools

    def planner(self) -> _OpenAIPlanner:
        return _OpenAIPlanner(self._messages)

    def assemble_prompt(self, messages: list[dict[str, Any]]) -> Any:
        return messages

    def run_wrapped(self, messages, dispatch) -> AgentRunResult:  # pragma: no cover - OWN
        raise NotImplementedError("openai is an OWN binding")
