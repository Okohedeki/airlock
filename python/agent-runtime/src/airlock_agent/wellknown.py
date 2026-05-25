"""Serve the airlock-config Bundle's well-known files — read-only, optional.

If the Publisher ran `airlock-config build`, its output lives at
`dist/.well-known/airlock-config.yaml` (+ index.html, llms.txt). We serve those
verbatim for discovery. The Bundle is an immutable input — we never modify it.
If there's no Bundle, discovery is simply off and the Agent still answers chat.
"""

from __future__ import annotations

import os
from typing import Any

WELLKNOWN_SUBPATH = ".well-known"
CONTRACT_FILENAME = "airlock-config.yaml"


def _bundle_dir(dist_dir: str) -> str:
    return os.path.join(dist_dir, WELLKNOWN_SUBPATH)


def has_bundle(dist_dir: str = "dist") -> bool:
    return os.path.isfile(os.path.join(_bundle_dir(dist_dir), CONTRACT_FILENAME))


def mount_wellknown(app: Any, dist_dir: str = "dist") -> bool:
    """Mount the Bundle's well-known dir at /.well-known if present. Returns
    True if mounted. Read-only; never writes."""
    directory = _bundle_dir(dist_dir)
    if not os.path.isfile(os.path.join(directory, CONTRACT_FILENAME)):
        return False
    from starlette.staticfiles import StaticFiles

    app.mount("/.well-known", StaticFiles(directory=directory), name="wellknown")
    return True


def read_contract_metadata(dist_dir: str = "dist") -> dict[str, Any] | None:
    """A few top-level contract fields for the info route. None if no Bundle."""
    path = os.path.join(_bundle_dir(dist_dir), CONTRACT_FILENAME)
    if not os.path.isfile(path):
        return None
    try:
        import yaml

        with open(path) as f:
            data = yaml.safe_load(f) or {}
        return {k: data[k] for k in ("agent", "category", "region", "skills") if k in data}
    except Exception:
        return {"present": True}
