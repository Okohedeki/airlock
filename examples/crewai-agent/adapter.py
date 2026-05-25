"""CrewAIAdapter — binds a CrewAI crew to airlock's chat surface (ADR-0007).

Mapping helpers are pure (no crewai import) so they're unit-testable with a stub
crew; crewai is imported lazily only when building the real crew.
"""

from __future__ import annotations

from typing import Any

from airlock_agent import AgentRunResult, messages_to_task


def final_content(result: Any) -> str:
    raw = getattr(result, "raw", None)
    return str(raw) if raw is not None else str(result)


def total_units(result: Any) -> int:
    tu = getattr(result, "token_usage", None)
    if tu is None:
        return 0
    return int(getattr(tu, "total_tokens", 0) or 0)


class CrewAIAdapter:
    def __init__(self, crew: Any | None = None) -> None:
        self._crew = crew  # injectable for tests

    def _build(self) -> Any:
        from agent import build_crew

        return build_crew()

    def run(self, messages: list[dict[str, Any]]) -> AgentRunResult:
        crew = self._crew or self._build()
        result = crew.kickoff(inputs={"input": messages_to_task(messages)})  # full native loop
        return AgentRunResult(content=final_content(result), units=total_units(result))
