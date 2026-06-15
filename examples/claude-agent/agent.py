"""Claude Agent SDK tools — production showcase harness (OWN).

airlock drives with its OWN model (worker.yaml `models`), so no Anthropic key is needed —
the SDK only contributes the tools. `build_options` returns the tool list (the entrypoint).
"""

from __future__ import annotations

from claude_agent_sdk import tool


@tool("multiply", "Multiply two integers", {"a": int, "b": int})
async def multiply(args):
    return {"content": [{"type": "text", "text": str(int(args["a"]) * int(args["b"]))}]}


@tool("danger", "Irreversibly delete a record (gated behind a disabled skill)", {"target": str})
async def danger(args):
    return {"content": [{"type": "text", "text": f"deleted {args['target']}"}]}


def build_options(model: str | None = None):
    return [multiply, danger]
