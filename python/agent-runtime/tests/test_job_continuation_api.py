"""Restart, review, and continue one durable job without replaying effects."""

import time

import pytest
from fastapi.testclient import TestClient

from airlock_agent.manifest import Manifest
from airlock_agent.runner import EngineRunner
from airlock_agent.state import SQLiteStore
from airlock_agent.surface import create_app


@pytest.fixture
def workers(tmp_path, monkeypatch):
    monkeypatch.setenv("AIRLOCK_OPERATOR_TOKEN", "operator")
    stores, effects = [], []
    config = {"harness": "stub", "auth": {"keys": {"key-a": "a", "key-b": "b"}},
              "controls": {"approvals": [{"tool": "send"}]}}

    def make():
        store = SQLiteStore(str(tmp_path / "state.db"))
        stores.append(store)
        runner = EngineRunner(Manifest.from_dict(config), store)
        runner.tools = {"bump": lambda: effects.append("bump"),
                        "send": lambda **args: effects.append(args)}
        return TestClient(create_app(runner), headers={
            "Authorization": "Bearer key-a", "X-Airlock-Operator-Token": "operator"})

    yield make, effects
    for store in stores:
        store._conn.close()


def settled(client, url):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        response = client.get(url)
        assert response.status_code == 200
        record = response.json()
        if record["status"] != "running":
            return record
        time.sleep(0.01)
    pytest.fail("job did not settle")


@pytest.mark.parametrize("decision", ["approve", "edit", "deny", "skip"])
def test_restart_review_continue_without_repeating_effects(workers, decision):
    make, effects = workers
    with make() as client:
        response = client.post("/v1/jobs", json={"messages": [{"role": "user", "content":
            'tool: bump {}\ntool: send {"text":"original"}\nfinal: done'}]})
        assert response.status_code == 202
        url = response.headers["location"]
        held = settled(client, url)
        assert held["status"] == "awaiting_approval"
        assert effects == ["bump"]
    # A fresh runtime and connection reopen the on-disk state.
    with make() as client:
        restored = settled(client, url)
        assert restored["approval"] == held["approval"]
        job_id = held["job_id"]
        review_id = held["approval"]["approval_id"]
        decision_url = f"/v1/runs/{job_id}/decision"
        assert client.post(decision_url, json={"decision": decision}).status_code == 400
        body = {"decision": decision, "approval_id": review_id, "args": {}}
        assert client.post(decision_url, json={**body, "approval_id": "stale"}).status_code == 409
        assert client.post(decision_url, json=body).status_code == 200
        assert client.post(decision_url, json=body).status_code == 409
        assert client.post(f"/v1/runs/{job_id}/resume").status_code == 409
        assert client.post(f"/v1/runs/{job_id}/fork", json={}).status_code == 409
        assert client.post("/v1/chat/completions", json={"run_id": job_id, "messages": []}).status_code == 409
        response = client.post(url + "/continue", json={"approval_id": review_id})
        assert response.status_code == 202, response.text
        outcome = settled(client, url)
        assert outcome["status"] == ("stopped" if decision == "deny" else "completed")
        assert outcome["run_id"] != job_id
        assert outcome["previous_run_ids"] == [job_id]
        assert client.post(url + "/continue", json={"approval_id": review_id}).status_code == 409
        assert client.post(f"/v1/runs/{outcome['run_id']}/resume").status_code == 409
    expected = ["bump", {"text": "original"}] if decision == "approve" else ["bump", {}] if decision == "edit" else ["bump"]
    assert effects == expected


def test_continuation_requires_operator_caller_and_current_review(workers):
    make, effects = workers
    with make() as client:
        receipt = client.post("/v1/jobs", json={"messages": [{"role": "user", "content":
            'tool: send {}\nfinal: done'}]}).json()
        job = settled(client, receipt["url"])
        url = receipt["url"] + "/continue"
        body = {"approval_id": job["approval"]["approval_id"]}
        assert client.post(url, json=body, headers={"X-Airlock-Operator-Token": ""}).status_code == 401
        assert client.post(url, json=body, headers={"Authorization": ""}).status_code == 401
        assert client.post(url, json=body, headers={"Authorization": "Bearer key-b"}).status_code == 404
        assert client.get("/v1/runs/held", headers={"Authorization": ""}).status_code == 401
        other = client.get("/v1/runs/held", headers={
            "Authorization": "Bearer key-b", "X-Airlock-Tenant": "a"}).json()
        assert other["held"] == []
        assert client.post(url, json=body).status_code == 409  # no decision yet
        assert effects == []
