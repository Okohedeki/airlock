"""Administration must not inherit caller, network, or proxy trust."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from airlock_agent.operator_auth import install_operator_auth


def client(token="operator-secret"):
    app = FastAPI()
    install_operator_auth(app, token)
    app.add_api_route("/v1/control/controls", lambda: {"changed": True}, methods=["POST"])
    app.add_api_route("/healthz", lambda: {"ok": True})
    app.add_api_route("/v1/chat/completions", lambda: {"ok": True}, methods=["POST"])
    return TestClient(app)


@pytest.mark.parametrize("path", [
    "/v1/control", "/v1/control/", "/v1/control/controls", "/v1/control/routing",
    "/v1/control/skills/send", "/v1/manifest", "/metrics", "/v1/runs/held",
    "/v1/runs/example/decision", "/v1/runs/example/decision/",
])
def test_administration_rejects_anonymous_requests(path):
    response = client().post(path)
    assert response.status_code == 401
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("headers", [
    {"Authorization": "Bearer operator-secret"},
    {"X-API-Key": "operator-secret"},
    {"X-Airlock-Operator-Token": "incorrect"},
    {"X-Forwarded-For": "127.0.0.1", "Host": "localhost"},
])
def test_caller_and_proxy_credentials_do_not_grant_operator_access(headers):
    assert client().post("/v1/control/controls", headers=headers).status_code == 401


def test_valid_operator_token_can_administer():
    response = client().post("/v1/control/controls", headers={
        "X-Airlock-Operator-Token": "operator-secret",
    })
    assert response.status_code == 200
    assert response.json() == {"changed": True}
    assert response.headers["cache-control"] == "no-store"


def test_missing_configuration_disables_administration():
    response = client("").post("/v1/control/controls", headers={
        "X-Airlock-Operator-Token": "operator-secret",
    })
    assert response.status_code == 503


def test_health_and_caller_routes_remain_independent():
    c = client("")
    assert c.get("/healthz").status_code == 200
    assert c.post("/v1/chat/completions").status_code == 200


def test_environment_token_is_captured_at_startup(monkeypatch):
    monkeypatch.setenv("AIRLOCK_OPERATOR_TOKEN", "initial")
    c = client(None)
    monkeypatch.setenv("AIRLOCK_OPERATOR_TOKEN", "changed")
    assert c.post("/v1/control/controls", headers={
        "X-Airlock-Operator-Token": "initial",
    }).status_code == 200
    assert c.post("/v1/control/controls", headers={
        "X-Airlock-Operator-Token": "changed",
    }).status_code == 401


def test_worker_rejects_caller_control_changes_without_mutating_state(monkeypatch):
    from airlock_agent.manifest import Manifest
    from airlock_agent.runner import EngineRunner
    from airlock_agent.state import MemoryStore
    from airlock_agent.surface import create_app

    monkeypatch.setenv("AIRLOCK_OPERATOR_TOKEN", "operator-secret")
    runner = EngineRunner(Manifest.from_dict({
        "harness": "stub",
        "auth": {"scheme": "api_key", "required": True},
        "tenancy": {"keys": {"caller-secret": "customer"}},
        "controls": {"max_steps": 8, "approvals": [{"tool": "send"}]},
    }), MemoryStore())
    c = TestClient(create_app(runner))
    payload = {"max_steps": 99999, "approval": {"tool": "send", "on": False}}
    for headers in ({}, {"Authorization": "Bearer caller-secret"}):
        assert c.post("/v1/control/controls", json=payload, headers=headers).status_code == 401
        assert c.post("/v1/runs/example/decision", json={"decision": "approve"},
                      headers=headers).status_code == 401
    assert runner.max_steps == 8
    assert runner.controls["approvals"] == [{"tool": "send"}]
    operator = {"X-Airlock-Operator-Token": "operator-secret"}
    assert c.post("/v1/control/controls", json=payload, headers=operator).status_code == 200
    # An operator credential is not a substitute for caller authentication either.
    assert c.post("/v1/chat/completions", headers=operator,
                  json={"messages": [{"role": "user", "content": "final: hi"}]}).status_code == 401
