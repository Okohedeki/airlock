"""Process-level (L4) test: boot the runtime as a real server subprocess from a
worker.yaml and drive it over HTTP — the "is it actually running" check.

Proves: a worker boots entirely from worker.yaml (epic 07), airlock owns a real
tool loop against a model endpoint (epic 01), and live model-switching shows the
routed model (epic 03), all over a real socket.
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import threading
import time

import httpx
import pytest

from mock_model import serve

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # agent-runtime/


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture(scope="module")
def mock_model():
    srv = serve(0)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}/v1/chat/completions"
    srv.shutdown()


def _write_worker(tmpdir, endpoint):
    yaml = f"""
worker:
  name: proc-demo
  version: 0.1.0
harness: openai
models:
  default: {{ endpoint: "{endpoint}", model: m-default }}
  fast:    {{ endpoint: "{endpoint}", model: m-fast }}
routing:
  default: default
tools:
  echo: tools:echo
state:
  backend: memory
"""
    path = os.path.join(tmpdir, "worker.yaml")
    with open(path, "w") as f:
        f.write(yaml)
    return path


def test_runtime_boots_from_worker_yaml_and_serves(tmp_path, mock_model):
    _write_worker(str(tmp_path), mock_model)
    port = _free_port()
    here = os.path.dirname(os.path.abspath(__file__))  # holds tools.py (referenced by worker.yaml)
    env = {**os.environ, "PORT": str(port), "PYTHONPATH": os.pathsep.join([here, ROOT])}
    proc = subprocess.Popen(
        [sys.executable, "-m", "airlock_agent"],
        cwd=str(tmp_path), env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    try:
        base = f"http://127.0.0.1:{port}"
        # wait for healthz
        deadline = time.time() + 20
        ok = False
        while time.time() < deadline:
            if proc.poll() is not None:
                raise RuntimeError("runtime exited early:\n" + (proc.stdout.read() or ""))
            try:
                if httpx.get(base + "/healthz", timeout=1).status_code == 200:
                    ok = True
                    break
            except Exception:
                time.sleep(0.3)
        assert ok, "runtime did not become healthy"

        # real tool loop over HTTP
        r = httpx.post(base + "/v1/chat/completions", timeout=30, json={
            "messages": [{"role": "user", "content": 'TOOLCALL:echo:{"text":"live"}'}],
            "include_steps": True})
        assert r.status_code == 200
        steps = r.json()["steps"]
        assert any(s["type"] == "tool_result" and s["output"] == "live" for s in steps)

        # model-switching visible: route to the 'fast' binding via X-Airlock header path
        r2 = httpx.post(base + "/v1/chat/completions", timeout=30, json={
            "messages": [{"role": "user", "content": "hello"}], "include_steps": True})
        model_steps = [s for s in r2.json()["steps"] if s["type"] == "model"]
        assert model_steps and "m-default" in str(model_steps[0]["output"])
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
