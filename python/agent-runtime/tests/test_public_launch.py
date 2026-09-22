import pytest
from fastapi.testclient import TestClient

from airlock_agent import AgentRunResult, create_app
from airlock_agent.auth import build_authenticator


class Adapter:
    def run(self, messages):
        return AgentRunResult(content="ok")


@pytest.mark.parametrize("auth", [
    {"scheme": "none"}, {"scheme": "open"}, {"required": False},
])
def test_public_launch_rejects_permissive_profiles(monkeypatch, auth):
    monkeypatch.setenv("AIRLOCK_PUBLIC_INSTANCE", "launch-identity")
    with pytest.raises(ValueError, match="require caller authentication"):
        build_authenticator(auth, {}, None)


def test_public_health_identifies_this_launch_without_caching(monkeypatch):
    monkeypatch.setenv("AIRLOCK_PUBLIC_INSTANCE", "launch-identity")
    app = create_app(Adapter(), name="test")
    monkeypatch.setenv("AIRLOCK_PUBLIC_INSTANCE", "later-change")
    response = TestClient(app).get("/healthz")
    assert response.json() == {"ok": True, "instance": "launch-identity"}
    assert response.headers["cache-control"] == "no-store"


def test_explicit_local_development_can_use_open_auth(monkeypatch):
    monkeypatch.delenv("AIRLOCK_PUBLIC_INSTANCE", raising=False)
    assert callable(build_authenticator({"scheme": "none"}, {}, None))
