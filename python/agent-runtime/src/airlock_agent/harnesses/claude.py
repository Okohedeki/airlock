"""Driver for the Claude Agent SDK. The entrypoint resolves to a ClaudeAgentOptions
object; the SDK is async, so we drive an event loop in the worker thread.
"""

from __future__ import annotations

from typing import Any

from ..adapter import AgentRunResult, messages_to_task


def _extract_text(messages: list[Any]) -> str:
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


def _extract_units(messages: list[Any]) -> int:
    for m in reversed(messages):
        usage = getattr(m, "usage", None)
        if isinstance(usage, dict):
            total = int(usage.get("total_tokens", 0) or 0)
            if total:
                return total
            return int(usage.get("input_tokens", 0) or 0) + int(usage.get("output_tokens", 0) or 0)
    return 0


def drive(options: Any, messages: list[dict[str, Any]]) -> AgentRunResult:
    import asyncio

    async def _collect() -> list[Any]:
        from claude_agent_sdk import query

        out: list[Any] = []
        async for message in query(prompt=messages_to_task(messages), options=options):
            out.append(message)
        return out

    collected = asyncio.run(_collect())
    return AgentRunResult(content=_extract_text(collected), units=_extract_units(collected))
