from airlock_agent import AgentRunResult, create_app
from airlock_payment import parse_payment_config
from fastapi.testclient import TestClient

WALLET = "0x" + "1" * 40


class FakeAdapter:
    """Stand-in Harness — no model, deterministic. Proves the surface alone."""

    def run(self, messages):
        last = messages[-1]["content"] if messages else ""
        return AgentRunResult(content=f"answer: {last}", units=42, unit_label="tokens")


def _client(payment_enabled=None):
    cfg = None
    if payment_enabled is not None:
        cfg = parse_payment_config(
            {"enabled": payment_enabled, "wallet": WALLET, "mode": "flat", "priceUsdc": "0.001"}
        )
    return TestClient(create_app(FakeAdapter(), name="test-agent", payment_config=cfg))


def test_chat_returns_standard_openai_completion():
    r = _client().post("/v1/chat/completions", json={"messages": [{"role": "user", "content": "hi"}]})
    assert r.status_code == 200
    body = r.json()
    assert body["object"] == "chat.completion"
    assert body["choices"][0]["message"]["content"] == "answer: hi"
    assert body["usage"]["total_tokens"] == 42
    assert r.headers.get("X-Airlock-Units") == "42"


def test_health_and_info():
    c = _client()
    assert c.get("/healthz").json() == {"ok": True}
    assert c.get("/").json()["shape"] == "openai"


def test_payment_off_passes_through():
    r = _client(payment_enabled=False).post(
        "/v1/chat/completions", json={"messages": [{"role": "user", "content": "hi"}]}
    )
    assert r.status_code == 200


def test_discovery_bundle_served_when_present(tmp_path):
    wk = tmp_path / ".well-known"
    wk.mkdir()
    (wk / "airlock-config.yaml").write_text("airlock_config: '0.5'\nagent: {name: t, version: 1.0.0}\n")
    client = TestClient(create_app(FakeAdapter(), name="t", dist_dir=str(tmp_path)))
    r = client.get("/.well-known/airlock-config.yaml")
    assert r.status_code == 200
    assert "airlock_config" in r.text
    assert client.get("/").json()["discovery"] == "/.well-known/airlock-config.yaml"


def test_no_bundle_means_discovery_off_but_agent_still_answers(tmp_path):
    client = TestClient(create_app(FakeAdapter(), name="t", dist_dir=str(tmp_path)))
    assert client.get("/.well-known/airlock-config.yaml").status_code == 404
    assert client.get("/").json()["discovery"] is None
    assert client.post("/v1/chat/completions", json={"messages": []}).status_code == 200


def test_payment_on_gates_chat_but_health_and_info_stay_free():
    c = _client(payment_enabled=True)
    # chat requires payment
    r = c.post("/v1/chat/completions", json={"messages": [{"role": "user", "content": "hi"}]})
    assert r.status_code == 402
    assert r.json()["x402Version"] == 1
    # health + info + discovery exempt
    assert c.get("/healthz").status_code == 200
    assert c.get("/").status_code == 200


# ---- concurrency: gate caps parallel runs, queues the rest, sheds overflow ----
import asyncio  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402

import httpx  # noqa: E402


class SlowAdapter:
    """Records the peak number of runs executing at the same instant."""

    def __init__(self, sleep_s=0.15):
        self.sleep_s = sleep_s
        self.live = 0
        self.peak = 0
        self._lock = threading.Lock()

    def run(self, messages):
        with self._lock:
            self.live += 1
            self.peak = max(self.peak, self.live)
        time.sleep(self.sleep_s)  # offloaded to the threadpool by run_in_threadpool
        with self._lock:
            self.live -= 1
        return AgentRunResult(content="ok", units=1)


def _fire(app, n):
    async def go():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as client:
            tasks = [
                client.post("/v1/chat/completions", json={"messages": [{"role": "user", "content": "x"}]})
                for _ in range(n)
            ]
            return await asyncio.gather(*tasks)

    return asyncio.run(go())


def test_runs_overlap_up_to_cap_and_queue_the_rest():
    adapter = SlowAdapter()
    app = create_app(adapter, name="t", max_concurrency=2, max_queue=50, queue_timeout_s=10)
    resps = _fire(app, 5)
    assert all(r.status_code == 200 for r in resps)  # all served (queued, not dropped)
    assert adapter.peak == 2  # never more than the cap in flight at once


def test_flood_beyond_queue_is_shed_with_429():
    adapter = SlowAdapter(sleep_s=0.2)
    app = create_app(adapter, name="t", max_concurrency=1, max_queue=1, queue_timeout_s=5)
    resps = _fire(app, 5)
    codes = [r.status_code for r in resps]
    assert codes.count(200) == 2  # 1 running + 1 queued
    assert codes.count(429) == 3  # the rest shed immediately
    assert all(r.json().get("error") for r in resps if r.status_code == 429)
