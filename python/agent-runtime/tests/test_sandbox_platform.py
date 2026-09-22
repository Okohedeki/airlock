"""Unsupported sandbox platforms must never silently run a tool in-process."""

import pytest

from airlock_agent.engine.sandbox import SandboxViolation, build_sandbox_dispatch, run_sandboxed


def test_missing_fork_refuses_tool_before_any_side_effect(monkeypatch):
    calls = []

    def unavailable(_method):
        raise ValueError("fork is unavailable")

    monkeypatch.setattr("airlock_agent.engine.sandbox.mp.get_context", unavailable)
    with pytest.raises(SandboxViolation, match="refusing tool execution"):
        run_sandboxed(lambda: calls.append("side effect"), {}, {"wall_s": 1})
    assert calls == []


def test_trusted_tool_opt_out_is_explicit():
    assert build_sandbox_dispatch({"enabled": False}) is None
