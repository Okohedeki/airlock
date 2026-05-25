"""LangGraph ReAct agent — the Harness. Built lazily so the adapter's mapping
logic stays importable/testable without langgraph installed.

    pip install -r requirements.txt
    OPENAI_API_BASE=http://localhost:8080/v1 python app.py
"""

from __future__ import annotations

import os

API_BASE = os.environ.get("OPENAI_API_BASE", "http://localhost:8080/v1")
API_KEY = os.environ.get("OPENAI_API_KEY", "not-needed")
MODEL_ID = os.environ.get("OPENAI_MODEL", "local-model")


def build_agent(api_base: str | None = None):
    from langchain_core.tools import tool
    from langchain_openai import ChatOpenAI
    from langgraph.prebuilt import create_react_agent

    @tool
    def multiply(a: int, b: int) -> int:
        """Multiply two integers."""
        return a * b

    model = ChatOpenAI(base_url=api_base or API_BASE, api_key=API_KEY, model=MODEL_ID)
    return create_react_agent(model, tools=[multiply])
