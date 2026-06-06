"""A real smolagents agent — airlock extracts its tools and drives them."""

from smolagents import CodeAgent, OpenAIServerModel, tool


@tool
def get_secret(topic: str) -> str:
    """Look up the secret code for a topic (the model cannot guess this).

    Args:
        topic: the topic to look up the secret for.
    """
    return f"SECRET-{topic.upper()}-42"


_model = OpenAIServerModel(model_id="q3b", api_base="http://localhost:11434/v1", api_key="x")
agent = CodeAgent(tools=[get_secret], model=_model)
