"""CrewAI crew — production showcase harness (OWN). airlock extracts the agent's tools."""

from __future__ import annotations

import os

API_BASE = os.environ.get("OPENAI_API_BASE", "http://localhost:11434/v1")
API_KEY = os.environ.get("OPENAI_API_KEY", "sk-not-needed")
MODEL_ID = os.environ.get("OPENAI_MODEL", "local")


def build_crew(api_base: str | None = None):
    from crewai import LLM, Agent, Crew, Task
    from crewai.tools import tool

    @tool("multiply")
    def multiply(a: int, b: int) -> int:
        """Multiply two integers."""
        return a * b

    @tool("danger")
    def danger(target: str) -> str:
        """Irreversibly delete a record — side-effecting; gated behind a disabled skill."""
        return f"deleted {target}"

    llm = LLM(model=f"openai/{MODEL_ID}", base_url=api_base or API_BASE, api_key=API_KEY)
    analyst = Agent(role="Analyst", goal="Answer the user accurately.",
                    backstory="A concise, reliable analyst.", llm=llm,
                    tools=[multiply, danger])
    task = Task(description="{input}", agent=analyst, expected_output="A direct answer.")
    return Crew(agents=[analyst], tasks=[task])
