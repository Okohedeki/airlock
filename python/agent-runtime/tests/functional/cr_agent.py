"""A real CrewAI agent — airlock extracts its tools and drives them."""

from crewai import LLM, Agent
from crewai.tools import tool


@tool("get_secret")
def get_secret(topic: str) -> str:
    """Look up the secret code for a topic (the model cannot guess this)."""
    return f"SECRET-{topic.upper()}-42"


# The LLM is only needed to construct the agent; airlock drives with its OWN model,
# so this is never actually called (any recognized model name works).
_llm = LLM(model="gpt-4o-mini", api_key="x", base_url="http://localhost:11434/v1")
agent = Agent(role="Secret Finder", goal="Find secret codes", backstory="An expert.",
              tools=[get_secret], llm=_llm)
