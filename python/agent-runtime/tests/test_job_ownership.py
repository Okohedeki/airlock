"""A crashed process releases ownership; a live process retains it."""

import os
from pathlib import Path
import subprocess
import sys

import pytest

from airlock_agent.state.ownership import exclusive_owner


def test_owner_is_exclusive_and_releases_after_exception(tmp_path):
    path = str(tmp_path / "jobs.lock")
    with pytest.raises(ValueError):
        with exclusive_owner(path):
            with pytest.raises(RuntimeError, match="already owned"):
                with exclusive_owner(path):
                    pytest.fail("second owner admitted")
            raise ValueError("shutdown")
    with exclusive_owner(path):
        pass


def test_process_death_releases_native_lock(tmp_path):
    path = str(tmp_path / "jobs.lock")
    ready = tmp_path / "ready"
    code = """
import sys, time
from pathlib import Path
from airlock_agent.state.ownership import exclusive_owner
with exclusive_owner(sys.argv[1]):
    Path(sys.argv[2]).write_text('ready')
    time.sleep(30)
"""
    env = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[1] / "src"))
    process = subprocess.Popen([sys.executable, "-c", code, path, str(ready)], env=env)
    try:
        import time

        deadline = time.monotonic() + 5
        while not ready.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        assert ready.exists(), "child did not acquire ownership"
        with pytest.raises(RuntimeError, match="already owned"):
            with exclusive_owner(path):
                pytest.fail("live worker lost ownership")
    finally:
        process.kill()
        process.wait(timeout=5)
    with exclusive_owner(path):
        pass
