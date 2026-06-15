"""worker.yaml loader — frozen contract C2 (epic 07).

The TS/CLI side owns and validates the schema; the runtime **loads and trusts**.
This module is a thin reader: `yaml.safe_load` + typed accessors. No jsonschema
dependency, no re-validation. Every value here is assumed already CLI-validated.
"""

from __future__ import annotations

import os
from typing import Any, Callable

import yaml

from .loader import load_entrypoint

WORKER_YAML = "worker.yaml"


class Manifest:
    """A loaded worker.yaml. Accessors return plain values / resolved callables."""

    def __init__(self, data: dict[str, Any], cwd: str | None = None) -> None:
        self._d = data or {}
        self._cwd = cwd or os.getcwd()

    # ---- load -------------------------------------------------------------
    @classmethod
    def load(cls, cwd: str | None = None) -> "Manifest":
        base = cwd or os.getcwd()
        path = os.path.join(base, WORKER_YAML)
        if not os.path.isfile(path):
            raise SystemExit(
                f"no {WORKER_YAML} found in {base} — run `airlock init` or `airlock migrate`."
            )
        with open(path) as f:
            data = yaml.safe_load(f) or {}
        return cls(data, cwd=base)

    @classmethod
    def from_dict(cls, data: dict[str, Any], cwd: str | None = None) -> "Manifest":
        return cls(data, cwd=cwd)

    # ---- composition ------------------------------------------------------
    def worker_name(self) -> str:
        return str(self._d.get("worker", {}).get("name") or "airlock-worker")

    def worker_version(self) -> str:
        return str(self._d.get("worker", {}).get("version") or "0.0.0")

    def harness(self) -> str:
        return str(self._d.get("harness") or "stub")

    def entrypoint(self) -> str | None:
        ep = self._d.get("entrypoint")
        return str(ep) if ep else None

    def tools(self) -> dict[str, Callable[..., Any]]:
        """Resolve `tools:` (name -> module:attr) to callables."""
        out: dict[str, Callable[..., Any]] = {}
        for name, spec in (self._d.get("tools") or {}).items():
            out[name] = load_entrypoint(str(spec))
        return out

    def skills(self) -> dict[str, dict[str, Any]]:
        """`skills:` normalized to id -> {tool, enabled}. A value may be a bare tool
        name (enabled) or an object {tool, enabled}. Skills = tools (epic 07)."""
        out: dict[str, dict[str, Any]] = {}
        for sid, spec in (self._d.get("skills") or {}).items():
            if isinstance(spec, dict):
                out[sid] = {"tool": spec.get("tool", sid), "enabled": spec.get("enabled", True)}
            else:
                out[sid] = {"tool": str(spec), "enabled": True}
        return out

    def enabled_tools(self) -> set[str] | None:
        """The tool names backing ENABLED skills, or None if no skills are declared
        (None = all tools available — back-compat). Disabling a skill removes its tool."""
        skills = self.skills()
        if not skills:
            return None
        return {s["tool"] for s in skills.values() if s.get("enabled", True)}

    def variant_names(self) -> list[str]:
        return list((self._d.get("variants") or {}).keys())

    def with_variant(self, name: str | None) -> "Manifest":
        """Return a new Manifest with `variants[name]` deep-merged over the base
        (the `variants` key itself is dropped from the result)."""
        if not name:
            return self
        overlay = (self._d.get("variants") or {}).get(name)
        if overlay is None:
            raise ValueError(f"unknown variant '{name}' (have: {', '.join(self.variant_names()) or 'none'})")
        base = {k: v for k, v in self._d.items() if k != "variants"}
        merged = _deep_merge(base, {k: v for k, v in overlay.items()
                                    if k not in ("capabilities", "cost_estimate")})
        return Manifest(merged, cwd=self._cwd)

    def models_config(self) -> dict[str, dict[str, Any]]:
        return dict(self._d.get("models") or {})

    def build_model_callers(self, tools_schema: list[dict] | None = None) -> dict[str, Callable]:
        """Build a name -> ModelCaller registry from `models:` (epics 01/03/07)."""
        from .harnesses.openai import http_model_caller
        from .harnesses.stub import echo_model_caller

        callers: dict[str, Callable] = {}
        for name, cfg in self.models_config().items():
            endpoint = cfg.get("endpoint")
            if endpoint:
                callers[name] = http_model_caller(
                    endpoint=str(endpoint),
                    model=str(cfg.get("model") or name),
                    env_key=str(cfg.get("env_key") or "OPENAI_API_KEY"),
                    tools_schema=tools_schema,
                )
            else:  # no endpoint → deterministic echo (stub/dev)
                callers[name] = echo_model_caller(name)
        if "default" not in callers:
            callers["default"] = echo_model_caller("default")
        return callers

    # ---- typed blocks (consumer epics read these) -------------------------
    def block(self, name: str) -> dict[str, Any]:
        v = self._d.get(name)
        return dict(v) if isinstance(v, dict) else {}

    def controls(self) -> dict[str, Any]:
        return self.block("controls")

    def routing(self) -> dict[str, Any]:
        return self.block("routing")

    def state_config(self) -> dict[str, Any]:
        return self.block("state")

    def io(self) -> dict[str, Any]:
        return self.block("io")

    def auth(self) -> dict[str, Any]:
        return self.block("auth")

    def tenancy(self) -> dict[str, Any]:
        return self.block("tenancy")

    def pricing(self) -> dict[str, Any]:
        return self.block("pricing")

    def sandbox(self) -> dict[str, Any]:
        return self.block("sandbox")

    def expose(self) -> str:
        return str(self._d.get("expose") or "internal")

    def raw(self) -> dict[str, Any]:
        return self._d


def _deep_merge(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    """Recursively merge `overlay` over `base` (dicts merge; everything else replaces)."""
    out = dict(base)
    for k, v in overlay.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out
