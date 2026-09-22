"""Strict prefix replay for continuing an approved, held run."""

import json
from dataclasses import fields

from .events import StepEvent, StepStatus, StepType
from .planner import ModelCall, ToolCall


def replay_step(action, recorded: dict, messages) -> StepEvent | None:
    """Validate the next action before reusing history or reaching a held tool.

    A changed planner must stop, not quietly execute a new tool in the recorded
    prefix. Model outputs are replayed too, so continuation does not replan the
    already-reviewed action. None denotes the validated approval boundary.
    """
    kind = recorded.get("type")
    if isinstance(action, ModelCall) and kind == "model":
        requested = action.messages or messages
        expected = recorded.get("input")
    elif isinstance(action, ToolCall) and kind in ("tool_result", "tool_call"):
        requested = {"tool": action.name, "args": action.args}
        expected = {"tool": recorded.get("tool"),
                    "args": recorded.get("requested_input", recorded.get("input"))}
    else:
        raise ValueError("continuation diverged from the recorded action sequence")
    if json.dumps(requested, sort_keys=True, allow_nan=False) != json.dumps(
            expected, sort_keys=True, allow_nan=False):
        raise ValueError("continuation action arguments changed; review required")
    if kind == "tool_call" and recorded.get("status") == "blocked":
        return None
    if recorded.get("status") != "ok":
        raise ValueError("cannot replay an uncertain or failed action")
    values = {f.name: recorded[f.name] for f in fields(StepEvent) if f.name in recorded}
    values.update(type=StepType(kind), status=StepStatus.OK, error="replayed", duration_ms=0)
    return StepEvent(**values)
