"""airlock-agent — deploy an agentic process behind an OpenAI-compatible API.

Wrap any Harness (LangGraph, CrewAI, smolagents, custom) in a small adapter and
call `serve(adapter)`. The agent answers POST /v1/chat/completions and serves an
airlock-config Bundle if present.

    from airlock_agent import HarnessAdapter, AgentRunResult, serve, messages_to_task

    class MyAdapter:
        def run(self, messages):
            answer = my_harness.run(messages_to_task(messages))  # full native loop
            return AgentRunResult(content=answer, units=0)

    serve(MyAdapter(), name="my-agent")
"""

from .adapter import (
    AgentRunResult,
    Binding,
    ControlMode,
    HarnessAdapter,
    last_user_message,
    messages_to_task,
)
from .concurrency import BoundedGate, ConcurrencyPolicy, QueueFull, resolve_policy
from .config import read_agent_config
from .engine import ControlSignal, RunContext, StepEvent, StepType, run_loop
from .harnesses import BindingSpec, SPECS, build_binding, control_mode, get_driver, is_reentrant
from .loader import Builder, load_entrypoint, resolve_builder, resolve_entrypoint
from .serve import serve
from .state import MemoryStore, SQLiteStore, StateStore, open_store
from .surface import create_app, to_chat_completion
from .wellknown import has_bundle, mount_wellknown, read_contract_metadata

__all__ = [
    "AgentRunResult",
    "Binding",
    "BindingSpec",
    "BoundedGate",
    "Builder",
    "ConcurrencyPolicy",
    "ControlMode",
    "ControlSignal",
    "HarnessAdapter",
    "MemoryStore",
    "QueueFull",
    "RunContext",
    "SPECS",
    "SQLiteStore",
    "StateStore",
    "StepEvent",
    "StepType",
    "build_binding",
    "control_mode",
    "create_app",
    "get_driver",
    "has_bundle",
    "is_reentrant",
    "last_user_message",
    "load_entrypoint",
    "messages_to_task",
    "mount_wellknown",
    "open_store",
    "read_agent_config",
    "read_contract_metadata",
    "resolve_builder",
    "resolve_entrypoint",
    "resolve_policy",
    "run_loop",
    "serve",
    "to_chat_completion",
]

__version__ = "0.0.0"
