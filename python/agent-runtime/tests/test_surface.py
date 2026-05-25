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
