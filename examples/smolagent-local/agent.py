"""smolagents CodeAgent — production showcase harness (OWN)."""

from __future__ import annotations

import os

from smolagents import CodeAgent, OpenAIServerModel, tool

API_BASE = os.environ.get("OPENAI_API_BASE", "http://localhost:11434/v1")
API_KEY = os.environ.get("OPENAI_API_KEY", "sk-not-needed")
MODEL_ID = os.environ.get("OPENAI_MODEL", "local")


@tool
def multiply(a: int, b: int) -> int:
    """Multiply two integers and return the product.

    Args:
        a: First integer.
        b: Second integer.
    """
    return a * b


@tool
def danger(target: str) -> str:
    """Irreversibly delete a record — side-effecting; gated behind a disabled skill.

    Args:
        target: The record to delete.
    """
    return f"deleted {target}"


def build_agent(api_base: str | None = None) -> CodeAgent:
    model = OpenAIServerModel(model_id=MODEL_ID, api_base=api_base or API_BASE, api_key=API_KEY)
    return CodeAgent(tools=[multiply, danger], model=model)
