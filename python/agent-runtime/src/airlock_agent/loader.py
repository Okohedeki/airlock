"""Resolve a developer's agent from an `entrypoint` string ("module:attr").

For the built-in harnesses the entrypoint is either an already-built agent object
or a build-once factory (named build_* / make_* / create_* / get_*). For `custom`,
the entrypoint is the per-request callable itself.

`resolve_builder` returns a re-callable `Builder` so the runtime can construct a
fresh, isolated wrapper PER REQUEST (factory entrypoints) instead of sharing one
object. `resolve_entrypoint` keeps the build-once behaviour for callers that want
a single instance.
"""

from __future__ import annotations

import importlib
from dataclasses import dataclass
from typing import Any, Callable

FACTORY_PREFIXES = ("build_", "make_", "create_", "get_")


def load_entrypoint(spec: str) -> Any:
    if ":" not in spec:
        raise ValueError(f"entrypoint must be 'module:attr', got '{spec}'")
    module_name, attr_path = spec.split(":", 1)
    obj: Any = importlib.import_module(module_name)
    for part in attr_path.split("."):
        obj = getattr(obj, part)
    return obj


@dataclass
class Builder:
    """Produces an agent object. For a factory entrypoint, `build()` calls the
    factory afresh each time (per-call isolation); otherwise it returns the same
    shared object (instance entrypoints, and `custom`'s per-request callable)."""

    _factory: Callable[[], Any] | None
    _instance: Any
    is_factory: bool

    def build(self) -> Any:
        if self._factory is not None:
            return self._factory()
        return self._instance


def resolve_builder(spec: str, harness: str) -> Builder:
    obj = load_entrypoint(spec)
    if harness == "custom":
        # the run(messages) callable — driven per request by the custom driver
        return Builder(_factory=None, _instance=obj, is_factory=False)
    leaf = spec.split(":", 1)[1].split(".")[-1]
    if callable(obj) and leaf.startswith(FACTORY_PREFIXES):
        return Builder(_factory=obj, _instance=None, is_factory=True)
    return Builder(_factory=None, _instance=obj, is_factory=False)


def resolve_entrypoint(spec: str, harness: str) -> Any:
    """Import the entrypoint and, for non-custom harnesses, call it once if it's a
    factory. Build-once: the model/graph/crew is constructed at startup, not per call."""
    return resolve_builder(spec, harness).build()
