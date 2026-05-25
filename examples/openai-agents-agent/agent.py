"""OpenAI Agents SDK agent — the Harness. Built lazily so the adapter's mapping
logic stays importable/testable without the SDK installed.

    pip install -r requirements.txt
    OPENAI_API_BASE=http://localhost:8080/v1 OPENAI_API_KEY=sk-... python app.py
"""

from __future__ import annotations

import os

API_BASE = os.environ.get("OPENAI_API_BASE", "http://localhost:8080/v1")
API_KEY = os.environ.get("OPENAI_API_KEY", "not-needed")
MODEL_ID = os.environ.get("OPENAI_MODEL", "local-model")


def build_agent(api_base: str | None = None):
    from agents import (
        Agent,
        function_tool,
        set_default_openai_api,
        set_default_openai_client,
        set_tracing_disabled,
    )
    from openai import AsyncOpenAI

    # Point the SDK at any OpenAI-compatible endpoint (local llama or a provider).
    client = AsyncOpenAI(base_url=api_base or API_BASE, api_key=API_KEY)
    set_default_openai_client(client)
    set_default_openai_api("chat_completions")  # local servers speak chat-completions
    set_tracing_disabled(True)

    @function_tool
    def multiply(a: int, b: int) -> int:
        """Multiply two integers."""
        return a * b

    return Agent(name="Assistant", instructions="Answer the user.", model=MODEL_ID, tools=[multiply])
