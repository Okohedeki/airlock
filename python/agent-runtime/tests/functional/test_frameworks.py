"""Framework adapter tests — airlock extracts each framework's tools and drives them.

These verify the hard part against the REAL framework objects: extraction yields a
working callable + a correct OpenAI tool schema. Each is skipped unless its framework
is installed (the agent frameworks need Python >=3.10, so run these in a 3.10+ venv:
`python3.12 -m venv .venv312 && . .venv312/bin/activate && pip install -e ".[dev]"
langgraph langchain-openai smolagents openai-agents crewai claude-agent-sdk`).

The model-drives-the-call integration was verified live against a local Qwen2.5-3B
(all 5 called the tool and returned the right answer); that step is model-dependent
so it isn't asserted here.
"""

from __future__ import annotations

import pytest

from airlock_agent.harnesses.extract import (
    extract_claude,
    extract_crewai,
    extract_langgraph,
    extract_openai_agents,
    extract_smolagents,
)


def _check(tools, expect="SECRET-LAUNCH-42"):
    assert "get_secret" in tools, f"get_secret not extracted (got {list(tools)})"
    fn = tools["get_secret"]
    assert fn(topic="launch") == expect  # the extracted wrapper actually runs the tool
    schema = getattr(fn, "_airlock_schema", None)
    assert schema and "topic" in schema["parameters"]["properties"]  # real param schema


def test_langgraph_extract():
    pytest.importorskip("langgraph")
    pytest.importorskip("langchain_openai")
    import lg_agent

    _check(extract_langgraph(lg_agent.agent)[0])


def test_smolagents_extract():
    pytest.importorskip("smolagents")
    import sm_agent

    _check(extract_smolagents(sm_agent.agent)[0])


def test_openai_agents_extract():
    pytest.importorskip("agents")
    import oa_agent

    tools, prompt = extract_openai_agents(oa_agent.agent)
    _check(tools)
    assert prompt  # instructions carried through as the system prompt


def test_crewai_extract():
    pytest.importorskip("crewai")
    import cr_agent

    _check(extract_crewai(cr_agent.agent)[0])


def test_claude_extract():
    pytest.importorskip("claude_agent_sdk")
    import cl_agent

    _check(extract_claude(cl_agent.tools)[0])
