"""LangGraphAdapter — binds a LangGraph agent to airlock's chat surface (ADR-0007).

The mapping helpers are pure (no langgraph import) so they're unit-testable with
a stub agent; the framework is imported lazily only when building the real agent.
"""

from __future__ import annotations

from typing import Any

from airlock_agent import AgentRunResult


def to_lc_messages(messages: list[dict[str, Any]]) -> list[tuple[str, str]]:
    """Full chat history → LangChain (role, content) tuples (stateless, Q2)."""
    return [(m.get("role", "user"), str(m.get("content", ""))) for m in messages]


def final_content(result: Any) -> str:
    msgs = result["messages"] if isinstance(result, dict) else getattr(result, "messages", [])
    return str(getattr(msgs[-1], "content", "")) if msgs else ""


def sum_units(result: Any) -> int:
    """Sum total_tokens across all messages' usage_metadata (across the run)."""
    msgs = result["messages"] if isinstance(result, dict) else getattr(result, "messages", [])
    total = 0
    for m in msgs:
        um = getattr(m, "usage_metadata", None)
        if isinstance(um, dict):
            total += int(um.get("total_tokens", 0) or 0)
    return total


class LangGraphAdapter:
    def __init__(self, agent: Any | None = None) -> None:
        self._agent = agent  # injectable for tests

    def _build(self) -> Any:
        from agent import build_agent

        return build_agent()

    def run(self, messages: list[dict[str, Any]]) -> AgentRunResult:
        agent = self._agent or self._build()
        result = agent.invoke({"messages": to_lc_messages(messages)})  # full native loop
        return AgentRunResult(content=final_content(result), units=sum_units(result))
