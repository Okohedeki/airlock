"""Resolve a developer's agent from an `entrypoint` string ("module:attr").

For the built-in harnesses the entrypoint is either an already-built agent object
or a build-once factory (named build_* / make_* / create_* / get_*), which we call
once at startup. For `custom`, the entrypoint is the per-request callable itself —
we return it as-is (the custom driver calls it each request).
"""

from __future__ import annotations

import importlib
from typing import Any

FACTORY_PREFIXES = ("build_", "make_", "create_", "get_")


def load_entrypoint(spec: str) -> Any:
    if ":" not in spec:
        raise ValueError(f"entrypoint must be 'module:attr', got '{spec}'")
    module_name, attr_path = spec.split(":", 1)
    obj: Any = importlib.import_module(module_name)
    for part in attr_path.split("."):
        obj = getattr(obj, part)
    return obj


def resolve_entrypoint(spec: str, harness: str) -> Any:
    """Import the entrypoint and, for non-custom harnesses, call it once if it's a
    factory. Build-once: the model/graph/crew is constructed at startup, not per call."""
    obj = load_entrypoint(spec)
    if harness == "custom":
        return obj  # the run(messages) callable — driven per request
    leaf = spec.split(":", 1)[1].split(".")[-1]
    if callable(obj) and leaf.startswith(FACTORY_PREFIXES):
        return obj()
    return obj
