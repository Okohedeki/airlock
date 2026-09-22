"""Approval identity, expiry, and single-consumer storage guarantees."""

from concurrent.futures import ThreadPoolExecutor
import time

import pytest

from airlock_agent.engine.planner import ToolCall
from airlock_agent.engine.policy import PolicyControlSource
from airlock_agent.state import MemoryStore, SQLiteStore


@pytest.fixture(params=["memory", "sqlite"])
def store(request, tmp_path):
    backend = MemoryStore() if request.param == "memory" else SQLiteStore(str(tmp_path / "state.db"))
    yield backend.scoped("tenant")
    if isinstance(backend, SQLiteStore):
        backend._conn.close()


def policy(store, window=0):
    return PolicyControlSource({"approvals": [{"tool": "send"}]}, store=store,
                               run_id="run", approval_window_s=window)


def approve(store, held):
    decision = {"decision": "approve", "approval_id": held["approval_id"],
                "tool": held["tool"], "original_args": held["args"]}
    assert store.compare_and_set(held["gate_key"], None, decision)


def test_atomic_claim_has_one_winner(store):
    store.set("claim", {"state": "ready"})
    with ThreadPoolExecutor(max_workers=8) as pool:
        outcomes = list(pool.map(lambda i: store.compare_and_set(
            "claim", {"state": "ready"}, {"winner": i}), range(32)))
    assert outcomes.count(True) == 1


def test_approval_cannot_authorize_changed_arguments(store):
    control = policy(store)
    pending = ToolCall("send", {"amount": 1})
    assert control.gate(pending).action == "pause"
    held = store.get("_held/run")
    approve(store, held)
    assert control.gate(ToolCall("send", {"amount": 2})).reason == "APPROVAL_ACTION_CHANGED"
    assert control.gate(ToolCall("send", {"amount": True})).reason == "APPROVAL_ACTION_CHANGED"
    assert control.gate(pending).action == "continue"
    assert store.get(held["gate_key"])["consumed_at"] > 0
    assert control.gate(pending).action == "pause"
    assert store.get("_held/run")["approval_id"] != held["approval_id"]


def test_approval_expires_without_refreshing_deadline(store):
    control = policy(store, window=10)
    pending = ToolCall("send", {})
    control.gate(pending)
    held = store.get("_held/run")
    assert control.gate(pending).action == "pause"
    assert store.get("_held/run")["deadline"] == held["deadline"]
    approve(store, held)
    store.set("_held/run", {**held, "deadline": time.time() - 1})
    assert control.gate(pending).reason == "APPROVAL_EXPIRED"
    assert "consumed_at" not in store.get(held["gate_key"])


def test_parallel_consumers_cannot_both_execute(store):
    pending = ToolCall("send", {})
    policy(store).gate(pending)
    approve(store, store.get("_held/run"))
    with ThreadPoolExecutor(max_workers=8) as pool:
        signals = list(pool.map(lambda _: policy(store).gate(pending), range(32)))
    assert sum(s.action == "continue" for s in signals) == 1


def test_approval_without_storage_fails_closed():
    assert policy(None).gate(ToolCall("send", {})).reason == "APPROVAL_STORAGE_REQUIRED"


def test_operator_edit_cannot_bypass_deny_rules(store):
    control = PolicyControlSource({"approvals": [{"tool": "send"}], "tool_gates": [
        {"tool": "send", "when": {"destination": "forbidden"}, "action": "deny"},
    ]}, store=store, run_id="run")
    pending = ToolCall("send", {"destination": "allowed"})
    control.gate(pending)
    held = store.get("_held/run")
    store.set(held["gate_key"], {"decision": "edit", "args": {"destination": "forbidden"},
                               "approval_id": held["approval_id"], "tool": "send",
                               "original_args": pending.args})
    assert control.gate_approved(pending, held["approval_id"]).reason == "TOOL_DENIED:send"
    assert "consumed_at" not in store.get(held["gate_key"])


def test_review_replacement_between_validation_and_consumption_is_rejected(store, monkeypatch):
    control = policy(store)
    pending = ToolCall("send", {})
    control.gate(pending)
    held = store.get("_held/run")
    approve(store, held)
    original_get = store.get
    reads = []

    def replace_on_second_read(key):
        if key == "_held/run":
            reads.append(True)
            if len(reads) == 2:
                store.set(key, {**held, "approval_id": "replacement"})
        return original_get(key)

    monkeypatch.setattr(store, "get", replace_on_second_read)
    assert control.gate_approved(pending, held["approval_id"]).reason == "APPROVAL_REVIEW_CHANGED"
    assert "consumed_at" not in store.get(held["gate_key"])


def test_wrapped_tools_cannot_bypass_pause_or_null_skip():
    from airlock_agent.adapter import AgentRunResult, ControlMode
    from airlock_agent.engine.loop import RunContext, run_loop

    calls = []
    store = MemoryStore().scoped("a")

    class Wrapped:
        control_mode = ControlMode.WRAP

        def tools(self):
            return {"send": lambda **args: calls.append(args)}

        def run_wrapped(self, messages, dispatch):
            dispatch("send", {})
            return AgentRunResult(content="done")

    with pytest.raises(RuntimeError, match="AWAIT_APPROVAL"):
        run_loop(Wrapped(), [], RunContext(control_source=policy(store)))
    held = store.get("_held/run")
    store.set(held["gate_key"], {"decision": "skip", "result": None,
                               "approval_id": held["approval_id"], "tool": "send", "original_args": {}})
    assert run_loop(Wrapped(), [], RunContext(control_source=policy(store))).content == "done"
    assert calls == []
