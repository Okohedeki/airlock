"""ClaudeAdapter — binds the Claude Agent SDK to airlock's surface (ADR-0007).

The SDK is async, so run() drives an event loop in the worker thread. The text/
usage extraction helpers are pure (no SDK import) and unit-testable with stub
messages; the SDK is imported lazily only when collecting a real run.
"""

from __future__ import annotations

from typing import Any

from airlock_agent import AgentRunResult, messages_to_task


def extract_text(messages: list[Any]) -> str:
    """Prefer the final ResultMessage's `.result`; else join assistant text blocks."""
    for m in reversed(messages):
        result = getattr(m, "result", None)
        if isinstance(result, str):
            return result
    texts: list[str] = []
    for m in messages:
        for block in getattr(m, "content", []) or []:
            text = getattr(block, "text", None)
            if isinstance(text, str):
                texts.append(text)
    return "\n".join(texts)


def extract_units(messages: list[Any]) -> int:
    """Total tokens across the run from the ResultMessage usage."""
    for m in reversed(messages):
        usage = getattr(m, "usage", None)
        if isinstance(usage, dict):
            total = int(usage.get("total_tokens", 0) or 0)
            if total:
                return total
            return int(usage.get("input_tokens", 0) or 0) + int(usage.get("output_tokens", 0) or 0)
    return 0


class ClaudeAdapter:
    def __init__(self, collect: Any | None = None) -> None:
        # `collect(task) -> list[message]` — injectable (sync) for tests.
        self._collect = collect

    def run(self, messages: list[dict[str, Any]]) -> AgentRunResult:
        task = messages_to_task(messages)
        collected = self._collect(task) if self._collect else self._collect_real(task)
        return AgentRunResult(content=extract_text(collected), units=extract_units(collected))

    def _collect_real(self, task: str) -> list[Any]:
        import asyncio

        return asyncio.run(self._acollect(task))

    async def _acollect(self, task: str) -> list[Any]:
        from agent import build_options
        from claude_agent_sdk import query

        out: list[Any] = []
        async for message in query(prompt=task, options=build_options()):
            out.append(message)
        return out
