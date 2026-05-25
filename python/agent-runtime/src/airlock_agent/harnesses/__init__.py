"""Built-in harness drivers, keyed by the `harness` config value.

A Driver runs a developer's pre-built agent object's full native loop and returns
an AgentRunResult. This is the logic that used to live in per-example adapters —
now config-selected, so a developer supplies only `[agent] harness + entrypoint`
and writes no adapter. See ADR-0007.
"""

from __future__ import annotations

from typing import Any, Callable

from ..adapter import AgentRunResult
from . import claude, crewai, custom, langgraph, openai_agents, smolagents

Driver = Callable[[Any, list[dict]], AgentRunResult]

DRIVERS: dict[str, Driver] = {
    "smolagents": smolagents.drive,
    "langgraph": langgraph.drive,
    "crewai": crewai.drive,
    "openai-agents": openai_agents.drive,
    "claude": claude.drive,
    "custom": custom.drive,
}


def get_driver(harness: str) -> Driver:
    try:
        return DRIVERS[harness]
    except KeyError:
        raise ValueError(
            f"unknown harness '{harness}'. Known: {', '.join(DRIVERS)}"
        ) from None
