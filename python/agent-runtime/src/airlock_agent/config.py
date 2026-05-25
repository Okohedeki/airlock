"""Read the `[agent]` block from `.airlock/config.toml`."""

from __future__ import annotations

import os
from typing import Any

try:
    import tomllib  # Python 3.11+
except ModuleNotFoundError:  # pragma: no cover
    import tomli as tomllib  # type: ignore


def read_agent_config(cwd: str | None = None) -> dict[str, Any]:
    """Return the `[agent]` table from .airlock/config.toml, or {} if absent."""
    path = os.path.join(cwd or os.getcwd(), ".airlock", "config.toml")
    if not os.path.isfile(path):
        return {}
    with open(path, "rb") as f:
        data = tomllib.load(f)
    agent = data.get("agent")
    return agent if isinstance(agent, dict) else {}
