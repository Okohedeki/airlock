"""Compatibility dispatch must never retry a callable after it has started."""

from fastapi.testclient import TestClient

from airlock_agent.adapter import AgentRunResult
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
