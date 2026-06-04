"""Frozen contract C1 — the planner protocol an OWN binding implements.

The planner is the harness's "brain" exposed to the engine: given the run history,
it returns the next Action. The engine executes it (model call / tool dispatch /
finish), records a StepEvent, and loops. This is how airlock owns the loop without
reimplementing each framework's reasoning.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, Union, runtime_checkable

from .events import StepEvent


@dataclass
class ModelCall:
    """Ask the model for the next move. `binding` selects a named model (epic 03)."""

    messages: list[dict[str, Any]] = field(default_factory=list)
    binding: str | None = None
    role: str | None = None  # optional routing tag (epic 03)


@dataclass
class ToolCall:
    name: str
    args: dict[str, Any] = field(default_factory=dict)


@dataclass
class Finish:
    content: str
    tokens: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0


Action = Union[ModelCall, ToolCall, Finish]


@runtime_checkable
class Planner(Protocol):
    def next_action(self, history: list[StepEvent]) -> Action: ...
