"""Real Claude Agent SDK tools — airlock extracts the handlers and drives them with
its OWN model (no Anthropic key needed)."""

from claude_agent_sdk import tool


@tool("get_secret", "Look up the secret code for a topic", {"topic": str})
async def get_secret(args):
    return {"content": [{"type": "text", "text": f"SECRET-{args['topic'].upper()}-42"}]}


# The entrypoint is the list of SDK tools; airlock drives them.
tools = [get_secret]
