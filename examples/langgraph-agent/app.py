"""Deployable service: a LangGraph agent behind an OpenAI-compatible API."""

from adapter import LangGraphAdapter
from airlock_agent import serve

if __name__ == "__main__":
    serve(LangGraphAdapter(), name="langgraph-agent")
