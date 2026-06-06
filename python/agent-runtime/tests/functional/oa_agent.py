"""A real OpenAI Agents SDK agent — airlock extracts its tools and drives them."""

from agents import Agent, function_tool


@function_tool
def get_secret(topic: str) -> str:
    """Look up the secret code for a topic (the model cannot guess this)."""
    return f"SECRET-{topic.upper()}-42"


agent = Agent(name="secret-agent", instructions="You look up secrets.", tools=[get_secret])
