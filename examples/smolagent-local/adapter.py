"""SmolagentsAdapter — binds a smolagents CodeAgent to airlock's chat surface.

This is the ~30-line "thin adapter" per ADR-0007: it maps chat messages to the
agent's task, runs the agent's FULL native loop (tools, code-exec, multi-step),
and reports billable units. The reusable surface + payment live in airlock-agent.
"""

from __future__ import annotations

from typing import Any

from agent import build_agent
from airlock_agent import AgentRunResult, messages_to_task


def _extract_units(agent: Any) -> tuple[int, str]:
    """Tokens summed across the run, with a step-count fallback (smolagents'
    token API is version-coupled — keep this defensive). See ADR-0007 risk."""
    try:
        m = agent.monitor
        total = int(getattr(m, "total_input_token_count", 0) or 0) + int(
            getattr(m, "total_output_token_count", 0) or 0
        )
        if total > 0:
            return total, "tokens"
    except Exception:
        pass
    try:
        return len(agent.memory.steps), "steps"
    except Exception:
        return 0, "tokens"


class SmolagentsAdapter:
    def run(self, messages: list[dict[str, Any]]) -> AgentRunResult:
        # Fresh agent per call → stateless (Q2) + correct per-run unit counts.
        agent = build_agent()
        task = messages_to_task(messages)
        answer = agent.run(task)  # full native loop: tools, code-exec, steps
        units, label = _extract_units(agent)
        return AgentRunResult(content=str(answer), units=units, unit_label=label)
