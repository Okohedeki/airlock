"""Durability, admission ownership, and conservative recovery of job records."""

import threading

import pytest

from airlock_agent.adapter import AgentRunResult
from airlock_agent.jobs import execute_job, job_worker, submit_job
from airlock_agent.state.sqlite import SQLiteStore


@pytest.fixture
def store(tmp_path):
    value = SQLiteStore(str(tmp_path / "state.db"))
    yield value
    value._conn.close()


@pytest.mark.parametrize("steps,status", [
    ([], "completed"),
    ([{"stop_reason": "AWAIT_APPROVAL", "status": "blocked"}], "awaiting_approval"),
    ([{"status": "blocked"}], "blocked"),
    ([{"status": "killed"}], "stopped"),
    ([{"stop_reason": "MAX_STEPS"}], "stopped"),
    ([{"status": "error"}], "failed"),
])
def test_job_outcomes(store, steps, status):
    job = {"tenant": "a", "job_id": "one", "messages": []}
    execute_job(store, job, lambda *args: AgentRunResult(content="result", steps=steps))
    assert store.get("a/_jobs/one")["status"] == status


def test_exception_is_not_retried_or_exposed(store):
    calls = []

    def call(*args):
        calls.append(True)
        raise TypeError("provider-secret")

    execute_job(store, {"tenant": "a", "job_id": "one", "messages": []}, call)
    record = store.get("a/_jobs/one")
    assert calls == [True]
    assert record["status"] == "failed"
    assert record["error_type"] == "TypeError"
    assert "provider-secret" not in str(record)


def test_persist_before_execution_and_drain_before_unlock(store):
    started, finish, released = threading.Event(), threading.Event(), threading.Event()

    def call(*args):
        assert store.get("a/_jobs/one")["status"] == "running"
        started.set()
        assert finish.wait(5)
        return AgentRunResult(content="done")

    with job_worker(store, 1) as executor:
        try:
            receipt = submit_job(store, executor, call, tenant="a", session="s",
                                 job_id="one", messages=[], release=released.set)
            assert receipt["status"] == "accepted"
            assert started.wait(5)
            assert not released.is_set()
            with pytest.raises(RuntimeError, match="already owned"):
                with job_worker(store, 1):
                    pytest.fail("second worker admitted")
        finally:
            finish.set()
    assert released.is_set()
    assert store.get("a/_jobs/one")["status"] == "completed"


def test_reopen_marks_only_unfinished_jobs_interrupted(store):
    for status in ["running", "completed", "awaiting_approval", "failed"]:
        store.set(f"a/_jobs/{status}", {"status": status, "messages": [{"content": "keep"}]})
    reopened = SQLiteStore(store.path)
    try:
        with job_worker(reopened, 1):
            assert reopened.get("a/_jobs/running")["status"] == "interrupted"
            assert reopened.get("a/_jobs/running")["messages"] == [{"content": "keep"}]
            for status in ["completed", "awaiting_approval", "failed"]:
                assert reopened.get(f"a/_jobs/{status}")["status"] == status
    finally:
        reopened._conn.close()
