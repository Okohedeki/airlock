"""`python -m airlock_agent` — the container entry point.

Reads `.airlock/config.toml [agent]`, imports the developer's agent once, selects
the built-in driver for `harness`, and serves the OpenAI-compatible surface. The
developer writes no app.py and no adapter — just the `[agent]` config block.
"""

from __future__ import annotations

import os
from typing import Any

from .adapter import AgentRunResult
from .config import read_agent_config
from .harnesses import Driver, get_driver
from .loader import resolve_entrypoint
from .serve import config_from_env
from .surface import create_app


class _DriverAdapter:
    """Wraps a (driver, agent-object) pair as a HarnessAdapter for the surface."""

    def __init__(self, driver: Driver, obj: Any) -> None:
        self._driver = driver
        self._obj = obj

    def run(self, messages: list[dict[str, Any]]) -> AgentRunResult:
        return self._driver(self._obj, messages)


def build_app(cwd: str | None = None):
    cfg = read_agent_config(cwd)
    harness = cfg.get("harness")
    entrypoint = cfg.get("entrypoint")
    if not harness or not entrypoint:
        raise SystemExit(
            "no [agent] block in .airlock/config.toml — need `harness` and `entrypoint`. "
            "Run `airlock init` to detect and write it."
        )
    obj = resolve_entrypoint(entrypoint, harness)  # build-once
    adapter = _DriverAdapter(get_driver(harness), obj)
    return create_app(adapter, name=str(harness), payment_config=config_from_env())


def main() -> None:
    import uvicorn

    uvicorn.run(build_app(), host="0.0.0.0", port=int(os.environ.get("PORT", "3000")))


if __name__ == "__main__":
    main()
