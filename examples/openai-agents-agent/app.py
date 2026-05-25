"""Deployable service: an OpenAI Agents SDK agent behind an OpenAI-compatible API."""

from adapter import OpenAIAgentsAdapter
from airlock_agent import serve

if __name__ == "__main__":
    serve(OpenAIAgentsAdapter(), name="openai-agents-agent")
