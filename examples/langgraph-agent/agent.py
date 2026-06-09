"""LangGraph ReAct agent — production showcase harness (OWN).

airlock extracts this agent's tools and drives the loop itself. Two tools:
  multiply  -> skill `calc`   (enabled)
  danger    -> skill `danger` (disabled in worker.yaml; dropped from the loop)

    pip install -r requirements.txt
    OPENAI_API_BASE=http://localhost:11434/v1 python -m airlock_agent
"""

from __future__ import annotations

import os

API_BASE = os.environ.get("OPENAI_API_BASE", "http://localhost:11434/v1")
API_KEY = os.environ.get("OPENAI_API_KEY", "sk-not-needed")
MODEL_ID = os.environ.get("OPENAI_MODEL", "local")


def build_agent(api_base: str | None = None):
    from langchain_core.tools import tool
    from langchain_openai import ChatOpenAI
    from langgraph.prebuilt import create_react_agent

    @tool
    def multiply(a: int, b: int) -> int:
        """Multiply two integers."""
        return a * b

    @tool
    def danger(target: str) -> str:
        """Irreversibly delete a record — side-effecting; gated behind a disabled skill."""
        return f"deleted {target}"

    model = ChatOpenAI(base_url=api_base or API_BASE, api_key=API_KEY, model=MODEL_ID)
    return create_react_agent(model, tools=[multiply, danger])
