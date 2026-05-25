"""Deployable service: a CrewAI crew behind an OpenAI-compatible API."""

from adapter import CrewAIAdapter
from airlock_agent import serve

if __name__ == "__main__":
    serve(CrewAIAdapter(), name="crewai-agent")
