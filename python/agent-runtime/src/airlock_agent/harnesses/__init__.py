"""Built-in harness drivers, keyed by the `harness` config value.

A Driver runs a developer's pre-built agent object's full native loop and returns
an AgentRunResult. This is the logic that used to live in per-example adapters —
now config-selected, so a developer supplies only `[agent] harness + entrypoint`
and writes no adapter. See ADR-0007.

`reentrant` declares whether a driver is safe to run in parallel on a SHARED
object. It only matters for the instance-entrypoint fallback: when the runtime
rebuilds a fresh object per request (factory entrypoints), every driver is
isolated by construction and this flag is moot. See ADR-0010.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from ..adapter import AgentRunResult
from . import claude, crewai, custom, langgraph, openai_agents, smolagents

Driver = Callable[[Any, list[dict]], AgentRunResult]


@dataclass(frozen=True)
class DriverSpec:
    fn: Driver
    reentrant: bool


SPECS: dict[str, DriverSpec] = {
    "smolagents": DriverSpec(smolagents.drive, reentrant=False),  # shared agent.memory/monitor
    "langgraph": DriverSpec(langgraph.drive, reentrant=True),  # stateless invoke
    "crewai": DriverSpec(crewai.drive, reentrant=False),  # shared Crew memory
    "openai-agents": DriverSpec(openai_agents.drive, reentrant=True),  # fresh Runner per call
    "claude": DriverSpec(claude.drive, reentrant=True),  # fresh asyncio.run(query) per call
    "custom": DriverSpec(custom.drive, reentrant=False),  # publisher's closure — assume unsafe
}

# Back-compat: a plain name→fn map for existing imports/tests.
DRIVERS: dict[str, Driver] = {name: spec.fn for name, spec in SPECS.items()}


def get_driver(harness: str) -> Driver:
    try:
        return SPECS[harness].fn
    except KeyError:
        raise ValueError(f"unknown harness '{harness}'. Known: {', '.join(SPECS)}") from None


def is_reentrant(harness: str) -> bool:
    spec = SPECS.get(harness)
    return bool(spec and spec.reentrant)
