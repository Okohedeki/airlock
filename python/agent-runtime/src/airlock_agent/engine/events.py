"""Frozen contract C1 — the uniform step record and the control directive.

`StepEvent` is what the engine emits per loop iteration; `ControlSignal` is what it
consumes between steps. These types are the frozen seam the rest of the engine builds
against — do not redefine them downstream.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Literal


class StepType(str, Enum):
    MODEL = "model"  # a model call (the planner produced an action)
    TOOL_CALL = "tool_call"  # a tool was dispatched
    TOOL_RESULT = "tool_result"  # a tool returned
    FINAL = "final"  # the loop reached a final answer


class StepStatus(str, Enum):
    OK = "ok"
    ERROR = "error"
    BLOCKED = "blocked"  # held by a ControlSignal (e.g. awaiting approval)
    KILLED = "killed"  # stopped by a guard / kill signal


@dataclass
class StepEvent:
    """One iteration of the loop, uniform across every harness."""

    index: int  # 0-based, monotonic within a run
    type: StepType
    input: Any = None  # redacted at the boundary by epics 05/13
    output: Any = None
    tokens: int = 0  # 0 = unknown (e.g. a tool-only step, or a WRAP harness)
    prompt_tokens: int = 0
    completion_tokens: int = 0
    duration_ms: float = 0.0
    cost_usd: float = 0.0  # per-step $ for MODEL steps (epic 05; 0 when no price/unknown)
    status: StepStatus = StepStatus.OK
    tool: str | None = None  # tool name when type is TOOL_*
    model: str | None = None  # binding name when type is MODEL (epic 03)
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "type": self.type.value,
            "input": self.input,
            "output": self.output,
            "tokens": self.tokens,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "duration_ms": round(self.duration_ms, 3),
            "cost_usd": round(self.cost_usd, 6),
            "status": self.status.value,
            "tool": self.tool,
            "model": self.model,
            "error": self.error,
        }


@dataclass
class ControlSignal:
    """A directive the loop consumes between steps, from policy or a human Operator.

    `override` carries exactly one of override_args / override_result / guidance.
    """

    action: Literal["continue", "pause", "retry", "kill", "override"] = "continue"
    override_args: dict[str, Any] | None = None  # rewrite the pending tool call's args
    override_result: Any | None = None  # skip the tool, inject this result
    guidance: str | None = None  # inject a nudge into history, then continue
    reason: str | None = None  # machine-readable reason (e.g. BUDGET_EXCEEDED)


CONTINUE = ControlSignal(action="continue")


class ControlSource:
    """Supplies a ControlSignal between steps. Epic 01 ships a no-op (always
    continue); epic 02 supplies the real policy/approval source."""

    def gate(self, pending: "Any") -> ControlSignal:  # called BEFORE a tool dispatch
        return CONTINUE

    def evaluate(self, history: list[StepEvent]) -> ControlSignal:  # BETWEEN steps
        return CONTINUE
