"""A real LangGraph create_react_agent — airlock extracts its tools and drives them."""

from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent


@tool
def get_secret(topic: str) -> str:
    """Look up the secret code for a topic (the model cannot guess this).

    Args:
        topic: the topic to look up the secret for.
    """
    return f"SECRET-{topic.upper()}-42"


# The model is only needed to build the graph; airlock drives with its OWN model.
_model = ChatOpenAI(base_url="http://localhost:11434/v1", api_key="x", model="q3b")
agent = create_react_agent(_model, [get_secret])
