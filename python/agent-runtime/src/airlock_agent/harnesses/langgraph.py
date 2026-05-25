"""Driver for a LangGraph agent (e.g. a compiled graph / create_react_agent)."""

from __future__ import annotations

from typing import Any

from ..adapter import AgentRunResult


def _to_lc_messages(messages: list[dict[str, Any]]) -> list[tuple[str, str]]:
    return [(m.get("role", "user"), str(m.get("content", ""))) for m in messages]


def _final_content(result: Any) -> str:
    msgs = result["messages"] if isinstance(result, dict) else getattr(result, "messages", [])
    return str(getattr(msgs[-1], "content", "")) if msgs else ""


def _sum_units(result: Any) -> int:
    msgs = result["messages"] if isinstance(result, dict) else getattr(result, "messages", [])
    total = 0
    for m in msgs:
        um = getattr(m, "usage_metadata", None)
        if isinstance(um, dict):
            total += int(um.get("total_tokens", 0) or 0)
    return total


def drive(agent: Any, messages: list[dict[str, Any]]) -> AgentRunResult:
    result = agent.invoke({"messages": _to_lc_messages(messages)})
    return AgentRunResult(content=_final_content(result), units=_sum_units(result))
