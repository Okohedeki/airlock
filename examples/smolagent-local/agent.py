"""smolagents CodeAgent definition — shared by the CLI script and the service.

`build_agent(api_base)` is the Harness. The deployable service (app.py) wraps it
in a HarnessAdapter; this file can also be run directly as a local smoke test.

CLI smoke test:
    ./tools/llama.cpp/build/bin/llama-server -m ./models/<model>.gguf --port 8080
    .venv/bin/python examples/smolagent-local/agent.py
"""

from __future__ import annotations

import os

from smolagents import CodeAgent, OpenAIServerModel, tool

# Model is a publisher-supplied OpenAI-compatible endpoint (ADR-0008):
# local llama in dev, a fast OS-model provider in prod.
API_BASE = os.environ.get("OPENAI_API_BASE", os.environ.get("LLAMA_API_BASE", "http://localhost:8080/v1"))
API_KEY = os.environ.get("OPENAI_API_KEY", "not-needed")
MODEL_ID = os.environ.get("OPENAI_MODEL", "local-model")


@tool
def multiply(a: int, b: int) -> int:
    """Multiply two integers and return the product.

    Args:
        a: First integer.
        b: Second integer.
    """
    return a * b


def build_agent(api_base: str | None = None) -> CodeAgent:
    model = OpenAIServerModel(
        model_id=MODEL_ID,
        api_base=api_base or API_BASE,
        api_key=API_KEY,
    )
    return CodeAgent(tools=[multiply], model=model, max_steps=4)


if __name__ == "__main__":
    agent = build_agent()
    result = agent.run("Use the multiply tool to compute 23 times 19, then report the result.")
    print("\n=== FINAL ANSWER ===")
    print(result)
