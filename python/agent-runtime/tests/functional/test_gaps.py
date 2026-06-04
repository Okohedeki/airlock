"""The finished gaps: 04 resume/fork, 03 fallback, 05 per-step cost, 13 output-enforce."""

from __future__ import annotations

import tools  # tests/functional/tools.py (pytest puts this dir on sys.path)


# --- Epic 04: resume re-feeds recorded tool results (no double side-effects) ----
def test_resume_does_not_rerun_side_effecting_tool(client_factory, store):
    tools.reset_bump()
    cfg = {"harness": "stub", "tools": {"bump": "tools:bump"}}
    c = client_factory(cfg, store)
    body = {"messages": [{"role": "user", "content": 'tool: bump {}\nfinal: done'}], "run_id": "r1"}
    c.post("/v1/chat/completions", json=body)
    assert tools.bump_count() == 1
    # resume: the recorded bump result is re-fed, the tool does NOT fire again
    r = c.post("/v1/runs/r1/resume")
    assert r.status_code == 200 and r.json()["content"] == "done"
    assert tools.bump_count() == 1  # still 1 — not re-run


def test_fork_replays_before_N_reruns_from_N(client_factory, store):
    tools.reset_bump()
    cfg = {"harness": "stub", "tools": {"bump": "tools:bump"}}
    c = client_factory(cfg, store)
    c.post("/v1/chat/completions",
           json={"messages": [{"role": "user", "content": 'tool: bump {}\nfinal: done'}], "run_id": "r2"})
    assert tools.bump_count() == 1
    # fork at step 1: bump (step 0) is < 1 → replayed, not re-run
    c.post("/v1/runs/r2/fork", json={"at_step": 1})
    assert tools.bump_count() == 1
    # fork at step 0: nothing replayed → bump re-runs
    c.post("/v1/runs/r2/fork", json={"at_step": 0})
    assert tools.bump_count() == 2


# --- Epic 03: fallback fires --------------------------------------------------
def test_model_failure_falls_back_to_backup(client_factory, mock_model_url):
    cfg = {
        "harness": "openai",
        "models": {
            "primary": {"endpoint": "http://127.0.0.1:9/v1/chat/completions", "model": "m-primary"},
            "backup": {"endpoint": mock_model_url, "model": "m-backup"},
        },
        "routing": {"default": "primary"},
        "fallback": {"retries": 1, "models": {"primary": ["backup"]}},
        "tools": {"echo": "tools:echo"},
    }
    c = client_factory(cfg)
    r = c.post("/v1/chat/completions",
               json={"messages": [{"role": "user", "content": "hello"}], "include_steps": True})
    assert r.status_code == 200
    # the dead primary failed; the backup answered (mock echoes its model name)
    assert "m-backup" in r.json()["choices"][0]["message"]["content"]


def test_tool_failure_falls_back_to_backup_tool(client_factory):
    cfg = {
        "harness": "stub",
        "tools": {"boom": "tools:boom", "echo": "tools:echo"},
        "fallback": {"tools": {"boom": ["echo"]}},
    }
    c = client_factory(cfg)
    r = c.post("/v1/chat/completions", json={
        "messages": [{"role": "user", "content": 'tool: boom {"text":"x"}\nfinal: ok'}],
        "include_steps": True})
    tool_steps = [s for s in r.json()["steps"] if s["type"] == "tool_result"]
    assert tool_steps and tool_steps[0]["status"] == "ok"  # echo backup ran, not the failed boom


# --- Epic 05: per-step $ cost -------------------------------------------------
def test_per_step_cost_surfaced(client_factory):
    cfg = {"harness": "stub", "pricing": {"default": {"per_1k": 0.01}}}
    c = client_factory(cfg)
    r = c.post("/v1/chat/completions", json={
        "messages": [{"role": "user", "content": "say: hi\nfinal: done"}], "include_steps": True})
    model_steps = [s for s in r.json()["steps"] if s["type"] == "model"]
    assert model_steps and model_steps[0]["cost_usd"] > 0  # tokens * price surfaced per step


# --- Epic 13: output enforcement / redaction ----------------------------------
def test_output_redaction(client_factory):
    cfg = {"harness": "stub", "io": {"output": {"redact": ["email"]}}}
    c = client_factory(cfg)
    r = c.post("/v1/chat/completions",
               json={"messages": [{"role": "user", "content": "final: contact me@example.com please"}]})
    assert "[REDACTED:email]" in r.json()["choices"][0]["message"]["content"]
    assert "me@example.com" not in r.json()["choices"][0]["message"]["content"]


def test_valid_json_output_passes(client_factory):
    cfg = {"harness": "stub", "io": {"output": {"format": "json"}}}
    c = client_factory(cfg)
    r = c.post("/v1/chat/completions",
               json={"messages": [{"role": "user", "content": 'final: {"ok": true}'}]})
    assert r.json()["choices"][0]["message"]["content"] == '{"ok": true}'
