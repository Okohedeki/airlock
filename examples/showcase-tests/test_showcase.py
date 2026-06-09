"""Containerized showcase tests — one green/red row per harness.

Run inside the showcase compose (`docker compose -f docker-compose.showcase.yml run --rm
harness-tests`), after each harness reports healthy. Assertions split two ways because the
showcase is driven by a REAL local LLM:

  * STRICT (deterministic, model-independent): healthz, manifest harness, skills 200/403/404,
    response shape, streaming frame sequence.
  * TOLERANT (real model, retried): the agent actually calls the `multiply` tool and the answer
    contains 437.

The "disabled skill drops the tool from the loop" guarantee is asserted deterministically in
the runtime unit suite (tests/functional/test_frameworks.py); here we assert its public face
(`/skills/danger` -> 403), which is deterministic.
"""

from __future__ import annotations

import os

import httpx
import pytest

TIMEOUT = httpx.Timeout(180.0)

# (id, base-url, expected harness)
OWN = [
    ("langgraph", os.environ.get("LANGGRAPH_URL"), "langgraph"),
    ("smolagents", os.environ.get("SMOLAGENTS_URL"), "smolagents"),
    ("crewai", os.environ.get("CREWAI_URL"), "crewai"),
    ("openai-agents", os.environ.get("OPENAI_AGENTS_URL"), "openai-agents"),
    ("claude", os.environ.get("CLAUDE_URL"), "claude"),
]
CUSTOM_URL = os.environ.get("CUSTOM_URL")


def _post(url, path, body):
    return httpx.post(url + path, json=body, timeout=TIMEOUT)


@pytest.mark.parametrize("name,url,harness", OWN, ids=[o[0] for o in OWN])
class TestOwnHarness:
    """The five OWN framework harnesses — full control set + skills on/off."""

    def test_healthz(self, name, url, harness):
        assert httpx.get(url + "/healthz", timeout=TIMEOUT).json() == {"ok": True}

    def test_manifest_harness(self, name, url, harness):
        assert httpx.get(url + "/v1/manifest", timeout=TIMEOUT).json()["harness"] == harness

    def test_skill_calc_enabled(self, name, url, harness):
        assert _post(url, "/skills/calc", {"input": "hi"}).status_code == 200

    def test_skill_danger_disabled(self, name, url, harness):
        assert _post(url, "/skills/danger", {"input": "hi"}).status_code == 403

    def test_skill_unknown_404(self, name, url, harness):
        assert _post(url, "/skills/nope", {"input": "hi"}).status_code == 404

    def test_response_shape(self, name, url, harness):
        d = _post(url, "/v1/chat/completions",
                  {"messages": [{"role": "user", "content": "hello"}]}).json()
        assert d["object"] == "chat.completion"
        assert d["choices"][0]["message"]["role"] == "assistant"
        assert {"prompt_tokens", "completion_tokens", "total_tokens"} <= set(d["usage"])

    def test_streaming_frames(self, name, url, harness):
        with httpx.stream("POST", url + "/v1/chat/completions",
                          json={"messages": [{"role": "user", "content": "hi"}], "stream": True},
                          timeout=TIMEOUT) as r:
            assert "text/event-stream" in r.headers.get("content-type", "")
            body = "".join(r.iter_text())
        assert "data: [DONE]" in body

    def test_real_model_calls_multiply(self, name, url, harness):
        """Tolerant: a real 3B sometimes loops or rephrases — retry, then assert a `multiply`
        tool_result fired AND the final answer contains 437 (23 * 19)."""
        last = None
        for _ in range(3):
            d = _post(url, "/v1/chat/completions", {
                "messages": [{"role": "user",
                              "content": "Use the multiply tool to compute 23 times 19, then state only the number."}],
                "include_steps": True}).json()
            last = d
            steps = d.get("steps", []) or []
            called = any(s.get("type") == "tool_result" and s.get("tool") == "multiply"
                         and s.get("status") == "ok" for s in steps)
            answer = d["choices"][0]["message"].get("content") or ""
            if called and "437" in answer:
                return
        pytest.fail(f"{name}: expected a multiply tool_result + '437' in the answer; last={last}")


def test_custom_is_terminal():
    """The custom harness is TERMINAL: it returns a result but extracts/dispatches NO tools."""
    assert httpx.get(CUSTOM_URL + "/healthz", timeout=TIMEOUT).json() == {"ok": True}
    assert httpx.get(CUSTOM_URL + "/v1/manifest", timeout=TIMEOUT).json()["harness"] == "custom"
    d = _post(CUSTOM_URL, "/v1/chat/completions",
              {"messages": [{"role": "user", "content": "compute 23 times 19"}],
               "include_steps": True}).json()
    assert "437" in (d["choices"][0]["message"].get("content") or "")
    assert not [s for s in (d.get("steps") or []) if s.get("type") == "tool_result"]
