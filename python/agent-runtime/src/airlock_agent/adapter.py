"""The HarnessAdapter contract — the one piece that differs per agent framework.

An adapter binds a Harness (LangGraph, CrewAI, smolagents, a custom loop) to
airlock's OpenAI-compatible surface. Its `run` MUST execute the Harness's full
native loop (hooks, tool-calling, multi-step) and return the final answer — it
is a faithful façade, never a flatten-to-single-LLM-call wrapper. See ADR-0007.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable


@dataclass
class AgentRunResult:
    """What an adapter returns from one chat call."""

    content: str
    """The agent run's final answer (becomes the chat completion content)."""
    units: int = 0
    """Billable units consumed by the run — tokens summed across all steps, or
    a step count. 0 = nothing to bill (fine when payment is off / flat)."""
    unit_label: str = "tokens"
    steps: list[Any] | None = None
    """Optional trace (deferred from the v1 response; kept for future verbose mode)."""


@runtime_checkable
class HarnessAdapter(Protocol):
    def run(self, messages: list[dict[str, Any]]) -> AgentRunResult: ...


def last_user_message(messages: list[dict[str, Any]]) -> str:
    """The last user turn — the simplest task extraction."""
    for m in reversed(messages):
        if m.get("role") == "user":
            return str(m.get("content", ""))
    return ""


def messages_to_task(messages: list[dict[str, Any]]) -> str:
    """Default task synthesis: the full transcript as text. The server is
    stateless (Q2) — the Caller sends the whole history each call, so we hand
    all of it to the Harness. Adapters may override with a harness-native map.
    """
    return "\n".join(f"{m.get('role', 'user')}: {m.get('content', '')}" for m in messages)
