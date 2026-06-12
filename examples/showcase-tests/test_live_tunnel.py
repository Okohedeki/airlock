"""Opt-in proof that airlock's guarantees hold over a REAL public URL — not localhost.

This is the network-facing sibling of test_showcase.py. It is **skipped by default** so the
hermetic suite and CI stay network-free; it runs only when `AIRLOCK_LIVE_TUNNEL_URL` points
at a live worker (set automatically by `scripts/live-proof.sh`, which boots a worker and
opens a real Cloudflare quick tunnel, then runs this module against the public URL).

Assertions are the STRICT, model-independent subset — the things airlock guarantees
regardless of which model answers (healthz, manifest, skill ACLs, response shape, streaming).
The actual agent loop (real model → tool → final, gating, approval) is exercised by the curl
battery in live-proof.sh and shown in the captured transcript.

    # the runnable proof exports this for you:
    AIRLOCK_LIVE_TUNNEL_URL=https://<rand>.trycloudflare.com \
        pytest examples/showcase-tests/test_live_tunnel.py -q
"""

from __future__ import annotations

import os

import httpx
import pytest

URL = os.environ.get("AIRLOCK_LIVE_TUNNEL_URL")
EXPECT_HARNESS = os.environ.get("AIRLOCK_LIVE_HARNESS", "openai")

pytestmark = pytest.mark.skipif(
    not URL,
    reason="set AIRLOCK_LIVE_TUNNEL_URL to a live public worker (see scripts/live-proof.sh)",
)

TIMEOUT = httpx.Timeout(180.0)


def _post(path, body):
    return httpx.post(URL + path, json=body, timeout=TIMEOUT)


def test_public_url_is_https_and_not_localhost():
    """The whole point: a real public address, not localhost / a private host."""
    assert URL.startswith("https://"), f"expected an https public URL, got {URL!r}"
    assert "localhost" not in URL and "127.0.0.1" not in URL


def test_healthz_over_tunnel():
    assert httpx.get(URL + "/healthz", timeout=TIMEOUT).json() == {"ok": True}


def test_manifest_harness_and_public_expose():
    m = httpx.get(URL + "/v1/manifest", timeout=TIMEOUT).json()
    assert m["harness"] == EXPECT_HARNESS
    # the worker declares its public reach — the expose flip is real, not a label
    assert m.get("expose") == "public"


def test_skill_enabled_200():
    assert _post("/skills/calc", {"input": "hi"}).status_code == 200


def test_skill_disabled_403():
    assert _post("/skills/danger", {"input": "hi"}).status_code == 403


def test_skill_unknown_404():
    assert _post("/skills/nope", {"input": "hi"}).status_code == 404


def test_response_shape_over_tunnel():
    d = _post("/v1/chat/completions",
              {"messages": [{"role": "user", "content": "hello"}]}).json()
    assert d["object"] == "chat.completion"
    assert d["choices"][0]["message"]["role"] == "assistant"
    assert {"prompt_tokens", "completion_tokens", "total_tokens"} <= set(d["usage"])


def test_streaming_frames_over_tunnel():
    with httpx.stream("POST", URL + "/v1/chat/completions",
                      json={"messages": [{"role": "user", "content": "hi"}], "stream": True},
                      timeout=TIMEOUT) as r:
        assert "text/event-stream" in r.headers.get("content-type", "")
        body = "".join(r.iter_text())
    assert "data: [DONE]" in body
