"""airlock-agent — deploy an agentic process behind an OpenAI-compatible API.

Wrap any Harness (LangGraph, CrewAI, smolagents, custom) in a small adapter and
call `serve(adapter)`. The agent answers POST /v1/chat/completions, mounts x402
payment in-process, and serves an airlock-config Bundle if present.

    from airlock_agent import HarnessAdapter, AgentRunResult, serve, messages_to_task

    class MyAdapter:
        def run(self, messages):
            answer = my_harness.run(messages_to_task(messages))  # full native loop
            return AgentRunResult(content=answer, units=0)

    serve(MyAdapter(), name="my-agent")
"""

from .adapter import (
    AgentRunResult,
    HarnessAdapter,
    last_user_message,
    messages_to_task,
)
from .serve import config_from_env, serve
from .surface import create_app, to_chat_completion
from .wellknown import has_bundle, mount_wellknown, read_contract_metadata

__all__ = [
    "AgentRunResult",
    "HarnessAdapter",
    "config_from_env",
    "create_app",
    "has_bundle",
    "last_user_message",
    "messages_to_task",
    "mount_wellknown",
    "read_contract_metadata",
    "serve",
    "to_chat_completion",
]

__version__ = "0.0.0"
