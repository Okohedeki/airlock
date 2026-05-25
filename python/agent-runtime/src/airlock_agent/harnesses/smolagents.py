"""Driver for a smolagents agent (e.g. CodeAgent). Operates on a pre-built agent
(build-once), runs its full native loop with reset=True for statelessness, and
counts usage as a per-call delta (the monitor accumulates across runs).
"""

from __future__ import annotations

from typing import Any

from ..adapter import AgentRunResult, messages_to_task


def _token_total(agent: Any) -> int:
    m = getattr(agent, "monitor", None)
    if m is None:
        return 0
    return int(getattr(m, "total_input_token_count", 0) or 0) + int(
        getattr(m, "total_output_token_count", 0) or 0
    )


def _steps(agent: Any) -> int:
    try:
        return len(agent.memory.steps)
    except Exception:
        return 0


def drive(agent: Any, messages: list[dict[str, Any]]) -> AgentRunResult:
    before = _token_total(agent)
    try:
        answer = agent.run(messages_to_task(messages), reset=True)
    except TypeError:
        answer = agent.run(messages_to_task(messages))
    delta = _token_total(agent) - before
    if delta > 0:
        return AgentRunResult(content=str(answer), units=delta, unit_label="tokens")
    return AgentRunResult(content=str(answer), units=_steps(agent), unit_label="steps")
