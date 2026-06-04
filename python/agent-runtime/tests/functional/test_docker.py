"""Docker functional test — runs the worker in a real container and drives it over
HTTP, proving the control plane is intact in-container (epic 09 / ADR-0012).

Opt-in (it needs Docker + the base image): run with
    AIRLOCK_DOCKER_TEST=1 pytest tests/functional/test_docker.py
Skipped by default so the hermetic suite stays fast and dependency-free.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import time

import httpx
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # agent-runtime/
DEMO = os.path.abspath(os.path.join(ROOT, "..", "..", "examples", "live-demo"))
IMAGE = "airlockhq/airlock:dev"

pytestmark = pytest.mark.skipif(
    os.environ.get("AIRLOCK_DOCKER_TEST") != "1" or shutil.which("docker") is None,
    reason="set AIRLOCK_DOCKER_TEST=1 and have Docker to run the in-container test",
)


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


@pytest.fixture(scope="module")
def base_image():
    subprocess.run(["docker", "build", "-t", IMAGE, ROOT], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    return IMAGE


def test_worker_runs_in_container(base_image):
    port = _free_port()
    name = f"airlock-pytest-{port}"
    subprocess.run(["docker", "rm", "-f", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run([
        "docker", "run", "-d", "--name", name, "-p", f"{port}:3000",
        "-v", f"{DEMO}:/app/worker", "-w", "/app/worker",
        "-e", "PYTHONPATH=/app/worker", "-e", "PORT=3000", base_image,
    ], check=True, stdout=subprocess.DEVNULL)
    try:
        base = f"http://127.0.0.1:{port}"
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                if httpx.get(base + "/healthz", timeout=1).status_code == 200:
                    break
            except Exception:
                time.sleep(0.5)
        else:
            raise AssertionError("container never became healthy")

        # console serves, the owned loop runs, sandbox enforces limits on Linux
        assert httpx.get(base + "/console", timeout=5).status_code == 200
        r = httpx.post(base + "/v1/chat/completions", timeout=20, json={
            "messages": [{"role": "user", "content": 'tool: echo {"text":"in-docker"}\nfinal: ok'}],
            "include_steps": True})
        steps = r.json()["steps"]
        assert any(s["type"] == "tool_result" and s["output"] == "in-docker" for s in steps)

        r2 = httpx.post(base + "/v1/chat/completions", timeout=20, json={
            "messages": [{"role": "user", "content": 'tool: slow {"seconds":5}\nfinal: x'}],
            "include_steps": True})
        tool = [s for s in r2.json()["steps"] if s["type"] == "tool_result"][0]
        assert tool["status"] == "error" and "wall_s" in (tool["error"] or "")
    finally:
        subprocess.run(["docker", "rm", "-f", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
