"""Driver for a custom harness: the entrypoint is a callable. Contract is
`run(messages) -> str` (or it may return an AgentRunResult directly). Falls back
to `run(task: str)` for callables that take a single prompt string.
"""

from __future__ import annotations

from typing import Any

from ..adapter import AgentRunResult, messages_to_task


def drive(fn: Any, messages: list[dict[str, Any]]) -> AgentRunResult:
    if not callable(fn):
        raise TypeError("custom harness entrypoint must be callable: run(messages) -> str")
    try:
        out = fn(messages)
    except TypeError:
        out = fn(messages_to_task(messages))
    if isinstance(out, AgentRunResult):
        return out
    return AgentRunResult(content=str(out), units=0)
