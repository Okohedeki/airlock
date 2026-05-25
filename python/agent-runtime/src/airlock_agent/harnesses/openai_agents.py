"""Driver for an OpenAI Agents SDK agent (operates on a pre-built Agent)."""

from __future__ import annotations

from typing import Any

from ..adapter import AgentRunResult, messages_to_task


def _final_output(result: Any) -> str:
    return str(getattr(result, "final_output", "") or "")


def _total_units(result: Any) -> int:
    ctx = getattr(result, "context_wrapper", None)
    usage = getattr(ctx, "usage", None)
    total = int(getattr(usage, "total_tokens", 0) or 0)
    if total:
        return total
    for resp in getattr(result, "raw_responses", []) or []:
        u = getattr(resp, "usage", None)
        total += int(getattr(u, "total_tokens", 0) or 0)
    return total


def drive(agent: Any, messages: list[dict[str, Any]]) -> AgentRunResult:
    from agents import Runner

    result = Runner.run_sync(agent, messages_to_task(messages))
    return AgentRunResult(content=_final_output(result), units=_total_units(result))
