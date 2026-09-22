"""Jobs are independent of request lifetime but share caller auth and capacity."""

import threading
import time

import pytest
from fastapi.testclient import TestClient

from airlock_agent.adapter import AgentRunResult
from airlock_agent.auth import build_authenticator
from airlock_agent.state.sqlite import SQLiteStore
from airlock_agent.surface import create_app


@pytest.fixture
def worker(tmp_path):
    class Runner:
        def __init__(self):
            self.store = SQLiteStore(str(tmp_path / "state.db"))
            self.started = threading.Event()
            self.finish = threading.Event()
            self.calls = []
            self.authenticate = build_authenticator(
                {"keys": {"key-a": "a", "key-b": "b"}}, {}, self.store)

        def run(self, messages, **kwargs):
            self.calls.append(kwargs)
            self.started.set()
            assert self.finish.wait(5)
            return AgentRunResult(content="finished")

    runner = Runner()
    yield runner
    runner.finish.set()
    runner.store._conn.close()


def test_job_returns_before_completion_and_survives_app_restart(worker):
    app = create_app(worker, max_concurrency=1, max_queue=0)
    headers = {"Authorization": "Bearer key-a"}
    with TestClient(app) as client:
        try:
            response = client.post("/v1/jobs", headers=headers, json={"messages": []})
            assert response.status_code == 202
            assert worker.started.wait(2)
            url = response.headers["location"]
            assert client.get(url, headers=headers).json()["status"] == "running"
            assert client.post("/v1/jobs", headers=headers, json={"messages": []}).status_code == 429
            assert client.post("/v1/chat/completions", headers=headers,
                               json={"messages": []}).status_code == 429
        finally:
            worker.finish.set()
    with TestClient(create_app(worker)) as client:
        response = client.get(url, headers=headers)
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        assert response.json()["result"]["content"] == "finished"
        assert response.json()["status"] == "completed"
    assert len(worker.calls) == 1


def test_job_routes_enforce_authenticated_tenant(worker, monkeypatch):
    monkeypatch.setenv("AIRLOCK_OPERATOR_TOKEN", "operator")
    worker.finish.set()
    with TestClient(create_app(worker)) as client:
        assert client.post("/v1/jobs", json={"messages": []}).status_code == 401
        receipt = client.post("/v1/jobs", json={"messages": []}, headers={
            "Authorization": "Bearer key-a", "X-Airlock-Tenant": "b",
        }).json()
        url = receipt["url"]
        assert client.get(url).status_code == 401
        assert client.get(url, headers={"X-Airlock-Operator-Token": "operator"}).status_code == 401
        assert client.get(url + "?tenant=a", headers={
            "Authorization": "Bearer key-b", "X-Airlock-Tenant": "a",
        }).status_code == 404
        assert client.get(url, headers={"Authorization": "Bearer key-a"}).json()["tenant"] == "a"


@pytest.mark.parametrize("body", [None, [], {}, {"messages": "bad"},
                                      {"messages": [1]}, {"messages": [], "run_id": "reuse"}])
def test_invalid_job_input_never_executes(worker, body):
    with TestClient(create_app(worker)) as client:
        response = client.post("/v1/jobs", json=body, headers={"Authorization": "Bearer key-a"})
        assert response.status_code == 400
    assert worker.calls == []


def test_jobs_require_durable_storage():
    with TestClient(create_app(object())) as client:
        assert client.post("/v1/jobs", json={"messages": []}).status_code == 503


def test_failed_initial_persistence_releases_capacity_without_execution(worker, monkeypatch):
    app = create_app(worker)
    headers = {"Authorization": "Bearer key-a"}
    original = worker.store.set

    def fail(*args, **kwargs):
        raise OSError("storage unavailable")

    with TestClient(app, raise_server_exceptions=False) as client:
        monkeypatch.setattr(worker.store, "set", fail)
        assert client.post("/v1/jobs", headers=headers, json={"messages": []}).status_code == 500
        assert worker.calls == []
        assert app.state.run_gate.pending == 0
        monkeypatch.setattr(worker.store, "set", original)
        worker.finish.set()
        assert client.post("/v1/jobs", headers=headers, json={"messages": []}).status_code == 202


def test_failed_outcome_persistence_releases_capacity_without_retry(worker, monkeypatch):
    app = create_app(worker)
    original = worker.store.set

    def fail_completion(key, value, *args, **kwargs):
        if "/_jobs/" in key and value["status"] == "completed":
            raise OSError("disk full")
        return original(key, value, *args, **kwargs)

    with TestClient(app) as client:
        monkeypatch.setattr(worker.store, "set", fail_completion)
        try:
            response = client.post("/v1/jobs", json={"messages": []},
                                   headers={"Authorization": "Bearer key-a"})
            assert response.status_code == 202
        finally:
            worker.finish.set()
        deadline = time.monotonic() + 3
        while app.state.run_gate.pending and time.monotonic() < deadline:
            time.sleep(0.01)
        assert app.state.run_gate.pending == 0
        assert len(worker.calls) == 1
    monkeypatch.setattr(worker.store, "set", original)
    with TestClient(create_app(worker)) as client:
        record = client.get(response.headers["location"],
                            headers={"Authorization": "Bearer key-a"}).json()
        assert record["status"] == "interrupted"
    assert len(worker.calls) == 1
