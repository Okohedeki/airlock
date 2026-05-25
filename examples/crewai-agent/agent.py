"""CrewAI crew — the Harness. Built lazily so the adapter's mapping logic stays
importable/testable without crewai installed.

    pip install -r requirements.txt
    OPENAI_API_BASE=http://localhost:8080/v1 python app.py
"""

from __future__ import annotations

import os

API_BASE = os.environ.get("OPENAI_API_BASE", "http://localhost:8080/v1")
API_KEY = os.environ.get("OPENAI_API_KEY", "not-needed")
MODEL_ID = os.environ.get("OPENAI_MODEL", "local-model")


def build_crew(api_base: str | None = None):
    from crewai import LLM, Agent, Crew, Task

    llm = LLM(model=f"openai/{MODEL_ID}", base_url=api_base or API_BASE, api_key=API_KEY)
    analyst = Agent(
        role="Analyst",
        goal="Answer the user's request accurately.",
        backstory="A concise, reliable analyst.",
        llm=llm,
    )
    task = Task(
        description="{input}",
        agent=analyst,
        expected_output="A direct answer to the request.",
    )
    return Crew(agents=[analyst], tasks=[task])
