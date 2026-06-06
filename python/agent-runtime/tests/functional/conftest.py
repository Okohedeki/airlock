"""Functional-test fixtures: the mock model server + an app factory."""

from __future__ import annotations

import threading

import pytest
from fastapi.testclient import TestClient

from airlock_agent.auth import build_authenticator
from airlock_agent.manifest import Manifest
from airlock_agent.runner import EngineRunner
from airlock_agent.state import MemoryStore
from airlock_agent.surface import create_app

from mock_model import serve


@pytest.fixture(scope="session")
def mock_model_url():
    srv = serve(0)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    port = srv.server_address[1]
    yield f"http://127.0.0.1:{port}/v1/chat/completions"
    srv.shutdown()


@pytest.fixture
def store():
    return MemoryStore()


def make_client(cfg: dict, store=None) -> TestClient:
    store = store or MemoryStore()
    manifest = Manifest.from_dict(cfg)
    runner = EngineRunner(manifest, store)
    authenticate = None
    if cfg.get("auth"):
        authenticate = build_authenticator(cfg["auth"], cfg.get("tenancy", {}), store)
    app = create_app(runner, name=cfg.get("worker", {}).get("name", "test"),
                     max_concurrency=4, max_queue=20, authenticate=authenticate)
    app.state._airlock_store = store  # let tests reach the store
    return TestClient(app)


@pytest.fixture
def client_factory():
    return make_client
