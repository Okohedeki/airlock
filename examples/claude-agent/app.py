"""Deployable service: a Claude Agent SDK agent behind an OpenAI-compatible API."""

from adapter import ClaudeAdapter
from airlock_agent import serve

if __name__ == "__main__":
    serve(ClaudeAdapter(), name="claude-agent")
