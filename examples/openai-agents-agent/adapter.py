"""OpenAIAgentsAdapter — binds the OpenAI Agents SDK to airlock's surface (ADR-0007).

Mapping helpers are pure (no SDK import) so they're unit-testable with a stub
result; the SDK is imported lazily only when running the real agent.
"""

from __future__ import annotations

from typing import Any

from airlock_agent import AgentRunResult, messages_to_task


def final_output(result: Any) -> str:
    return str(getattr(result, "final_output", "") or "")


def total_units(result: Any) -> int:
    """Tokens across the run: prefer the aggregated usage, else sum per-response."""
    ctx = getattr(result, "context_wrapper", None)
    usage = getattr(ctx, "usage", None)
    total = int(getattr(usage, "total_tokens", 0) or 0)
    if total:
        return total
    for resp in getattr(result, "raw_responses", []) or []:
        u = getattr(resp, "usage", None)
        total += int(getattr(u, "total_tokens", 0) or 0)
    return total


class OpenAIAgentsAdapter:
    def __init__(self, agent: Any | None = None, runner: Any | None = None) -> None:
        self._agent = agent  # injectable for tests
        self._runner = runner

    def _build(self) -> Any:
        from agent import build_agent

        return build_agent()

    def run(self, messages: list[dict[str, Any]]) -> AgentRunResult:
        agent = self._agent or self._build()
        if self._runner is not None:
            result = self._runner.run_sync(agent, messages_to_task(messages))
        else:
            from agents import Runner

            result = Runner.run_sync(agent, messages_to_task(messages))  # full native loop
        return AgentRunResult(content=final_output(result), units=total_units(result))
