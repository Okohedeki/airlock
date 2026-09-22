"""Real sockets and process death: disconnects must not cancel or replay jobs."""

import os
from pathlib import Path
import socket
import subprocess
import sys
import time

import httpx


SERVER = """
import sys, time
from pathlib import Path
import uvicorn
from airlock_agent.adapter import AgentRunResult
from airlock_agent.state.sqlite import SQLiteStore
from airlock_agent.surface import create_app
class Runner:
    store = SQLiteStore(sys.argv[1])
    def run(self, messages, **kwargs):
        with open(sys.argv[2], 'a') as effects:
            effects.write(kwargs['run_id'] + '\\n')
        time.sleep(0.2 if messages[0]['content'] == 'finish' else 60)
        return AgentRunResult(content='done')
uvicorn.run(create_app(Runner()), host='127.0.0.1', port=int(sys.argv[3]),
            log_level='error', proxy_headers=False)
"""


def test_disconnect_completion_and_crash_recovery_without_repeating_effects(tmp_path):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    effects = tmp_path / "effects.txt"
    env = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[1] / "src"))

    def start():
        proc = subprocess.Popen(
            [sys.executable, "-c", SERVER, str(tmp_path / "state.db"), str(effects), str(port)],
            env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        try:
            deadline = time.monotonic() + 10
            with httpx.Client(base_url=base, timeout=1, trust_env=False) as client:
                while time.monotonic() < deadline:
                    assert proc.poll() is None, proc.stdout.read()
                    try:
                        if client.get("/healthz").status_code == 200:
                            return proc
                    except httpx.TransportError:
                        pass
                    time.sleep(0.03)
            raise AssertionError("worker failed to become ready")
        except BaseException:
            proc.kill()
            proc.wait(timeout=5)
            raise

    proc = start()
    try:
        with httpx.Client(base_url=base, trust_env=False) as client:
            response = client.post("/v1/jobs", json={"messages": [{"content": "finish"}]})
            assert response.status_code == 202
            completed_url = response.headers["location"]
        # The submitting connection is gone. A fresh connection observes completion.
        with httpx.Client(base_url=base, trust_env=False) as client:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if client.get(completed_url).json()["status"] == "completed":
                    break
                time.sleep(0.02)
            assert client.get(completed_url).json()["status"] == "completed"
            response = client.post("/v1/jobs", json={"messages": [{"content": "block"}]})
            assert response.status_code == 202
            interrupted_url = response.headers["location"]
            deadline = time.monotonic() + 5
            while len(effects.read_text().splitlines()) < 2 and time.monotonic() < deadline:
                time.sleep(0.02)
            before = effects.read_text()
            assert len(before.splitlines()) == 2
        proc.kill()
        proc.wait(timeout=5)
        proc = start()
        with httpx.Client(base_url=base, trust_env=False) as client:
            assert client.get(interrupted_url).json()["status"] == "interrupted"
            assert client.get(completed_url).json()["status"] == "completed"
            assert effects.read_text() == before
    finally:
        proc.kill()
        proc.wait(timeout=5)
