"""Driver for a CrewAI crew (operates on a pre-built Crew)."""

from __future__ import annotations

from typing import Any

from ..adapter import AgentRunResult, messages_to_task


def _final_content(result: Any) -> str:
    raw = getattr(result, "raw", None)
    return str(raw) if raw is not None else str(result)


def _total_units(result: Any) -> int:
    tu = getattr(result, "token_usage", None)
    return int(getattr(tu, "total_tokens", 0) or 0) if tu is not None else 0


def drive(crew: Any, messages: list[dict[str, Any]]) -> AgentRunResult:
    result = crew.kickoff(inputs={"input": messages_to_task(messages)})
    return AgentRunResult(content=_final_content(result), units=_total_units(result))
