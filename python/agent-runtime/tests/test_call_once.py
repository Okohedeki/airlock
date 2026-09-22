"""Compatibility dispatch must never retry a callable after it has started."""

from fastapi.testclient import TestClient
import pytest

from airlock_agent.adapter import AgentRunResult
from airlock_agent.engine.loop import _call_tool
from airlock_agent.surface import create_app


def test_runner_type_error_does_not_repeat_side_effects():
    calls = []

    class Runner:
        def run(self, messages, **kwargs):
            calls.append(messages)
            raise TypeError("failure after external action")

    with TestClient(create_app(Runner()), raise_server_exceptions=False) as client:
        response = client.post("/v1/chat/completions", json={"messages": []})
    assert response.status_code == 500
    assert len(calls) == 1


def test_legacy_runner_signature_still_works():
    class Runner:
        def run(self, messages):
            return AgentRunResult(content="legacy")

    with TestClient(create_app(Runner())) as client:
        response = client.post("/v1/chat/completions", json={"messages": []})
    assert response.status_code == 200
    assert response.json()["choices"][0]["message"]["content"] == "legacy"


def test_tool_type_error_does_not_repeat_side_effects():
    calls = []

    def tool(*args, **kwargs):
        calls.append((args, kwargs))
        raise TypeError("failure after external action")

    with pytest.raises(TypeError, match="after external action"):
        _call_tool(tool, {"destination": "example"})
    assert calls == [((), {"destination": "example"})]


def test_tool_argument_shapes_are_selected_without_execution():
    assert _call_tool(lambda value: value + 1, {"value": 2}) == 3
    assert _call_tool(lambda payload: payload["value"] + 1, {"value": 2}) == 3
    assert _call_tool(lambda payload, /: payload["value"], {"value": 2}) == 2
    calls = []

    def incompatible(first, second):
        calls.append(first)

    with pytest.raises(TypeError):
        _call_tool(incompatible, {"value": 2})
    assert calls == []
