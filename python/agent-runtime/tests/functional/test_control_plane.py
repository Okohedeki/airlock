"""Functional tests for the live control plane (operator console mutations).

The control plane layers EPHEMERAL runtime overrides on top of the frozen worker.yaml:
toggle skills, switch the model binding, adjust guards — applied to subsequent runs without
rewriting the manifest. These tests exercise the exact HTTP API the /console UI calls.
"""

from __future__ import annotations

CFG = {
    "worker": {"name": "ctl", "version": "0.1.0"},
    "harness": "stub",
    "tools": {"echo": "tools:echo", "add": "tools:add"},
    "skills": {
        "calc": {"tool": "echo", "enabled": True},
        "mailer": {"tool": "add", "enabled": True},
    },
    "controls": {"max_steps": 8, "approvals": [{"tool": "add"}]},
    "models": {"primary": {}, "fast": {}},
    "routing": {"default": "primary"},
}


def test_control_get_reports_full_state(client_factory):
    c = client_factory(CFG)
    s = c.get("/v1/control").json()
    assert s["worker"]["name"] == "ctl"
    assert s["models"]["default"] == "primary"
    assert {b["name"] for b in s["models"]["bindings"]} == {"primary", "fast"}
    assert {sk["id"] for sk in s["skills"]} == {"calc", "mailer"}
    assert s["controls"]["max_steps"] == 8 and "add" in s["controls"]["approvals"]
    assert set(s["tools"]) == {"echo", "add"}


def test_toggle_skill_drops_and_restores_tool(client_factory):
    c = client_factory(CFG)
    # disable calc → its tool `echo` leaves the loop AND /skills/calc → 403
    r = c.post("/v1/control/skills/calc", json={"enabled": False})
    assert r.status_code == 200 and r.json()["enabled"] is False
    s = c.get("/v1/control").json()
    assert "echo" not in s["tools"]
    assert c.post("/skills/calc", json={"input": "hi"}).status_code == 403
    assert s["overrides"]["skills"]["calc"] is False
    # re-enable → tool returns, /skills/calc serves again
    c.post("/v1/control/skills/calc", json={"enabled": True})
    assert "echo" in c.get("/v1/control").json()["tools"]


def test_unknown_skill_404(client_factory):
    c = client_factory(CFG)
    assert c.post("/v1/control/skills/nope", json={"enabled": False}).status_code == 404


def test_switch_routing_default(client_factory):
    c = client_factory(CFG)
    assert c.post("/v1/control/routing", json={"default": "fast"}).json()["default"] == "fast"
    assert c.get("/v1/control").json()["models"]["default"] == "fast"
    # unknown binding rejected
    assert c.post("/v1/control/routing", json={"default": "ghost"}).status_code == 400


def test_adjust_guards_live(client_factory):
    c = client_factory(CFG)
    out = c.post("/v1/control/controls", json={"max_steps": 3, "budget.tokens": 20}).json()
    assert out["max_steps"] == 3 and out["budget"]["tokens"] == 20
    # add + remove an approval hold
    assert "echo" in c.post("/v1/control/controls",
                            json={"approval": {"tool": "echo", "on": True}}).json()["approvals"]
    assert "echo" not in c.post("/v1/control/controls",
                                json={"approval": {"tool": "echo", "on": False}}).json()["approvals"]
    # the deterministic loop-behavior consequence (a disabled skill's tool leaves the loop) is
    # proven for real harnesses by the showcase grid (danger disabled → dropped); here we assert
    # the control-plane contract: the tool is gone from the effective tool set + /skills → 403
    # (see test_toggle_skill_drops_and_restores_tool).
