"""Functional tests for the Operator Console read APIs + page (epic 05 / UX)."""

from __future__ import annotations


def test_console_page_served(client_factory):
    c = client_factory({"harness": "stub"})
    r = c.get("/console")
    assert r.status_code == 200 and "airlock console" in r.text


def test_manifest_view_redacts_keys(client_factory):
    cfg = {
        "worker": {"name": "demo", "version": "0.2.0"}, "harness": "stub",
        "models": {"default": {}, "fast": {}},
        "tools": {"echo": "tools:echo"},
        "controls": {"max_steps": 9, "approvals": [{"tool": "send"}]},
        "auth": {"scheme": "api_key"}, "tenancy": {"keys": {"k-secret": "acme"}},
    }
    c = client_factory(cfg)
    m = c.get("/v1/manifest").json()
    assert m["name"] == "demo" and m["harness"] == "stub"
    assert set(m["models"]) == {"default", "fast"} and m["controls"]["max_steps"] == 9
    assert m["controls"]["approvals"] == ["send"]
    # tenant NAMES are exposed, the secret keys are NOT
    assert m["tenants"] == ["acme"]
    assert "k-secret" not in str(m)


def test_runs_indexed_and_detail(client_factory, store):
    c = client_factory({"harness": "stub", "tools": {"echo": "tools:echo"}}, store)
    c.post("/v1/chat/completions",
           json={"messages": [{"role": "user", "content": "tool: echo {}\nfinal: ok"}]})
    runs = c.get("/v1/runs?tenant=default").json()["runs"]
    assert runs and runs[0]["status"] == "ok" and runs[0]["n_steps"] >= 2
    detail = c.get(f"/v1/runs/{runs[0]['run_id']}?tenant=default").json()
    assert [s["type"] for s in detail["steps"]][-1] == "final"


def test_run_detail_404(client_factory):
    c = client_factory({"harness": "stub"})
    assert c.get("/v1/runs/nope?tenant=default").status_code == 404
