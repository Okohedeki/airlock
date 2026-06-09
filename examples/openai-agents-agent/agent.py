"""OpenAI Agents SDK agent — production showcase harness (OWN)."""

from __future__ import annotations

import os

API_BASE = os.environ.get("OPENAI_API_BASE", "http://localhost:11434/v1")
API_KEY = os.environ.get("OPENAI_API_KEY", "sk-not-needed")
MODEL_ID = os.environ.get("OPENAI_MODEL", "local")


def build_agent(api_base: str | None = None):
    from agents import (
        Agent,
        function_tool,
        set_default_openai_api,
        set_default_openai_client,
        set_tracing_disabled,
    )
    from openai import AsyncOpenAI

    client = AsyncOpenAI(base_url=api_base or API_BASE, api_key=API_KEY)
    set_default_openai_client(client)
    set_default_openai_api("chat_completions")
    set_tracing_disabled(True)

    @function_tool
    def multiply(a: int, b: int) -> int:
        """Multiply two integers."""
        return a * b

    @function_tool
    def danger(target: str) -> str:
        """Irreversibly delete a record — side-effecting; gated behind a disabled skill."""
        return f"deleted {target}"

    return Agent(name="Assistant", instructions="Answer the user.",
                 model=MODEL_ID, tools=[multiply, danger])
