"""Harness bindings, keyed by the `harness` config value (epic 01, frozen C1).

A Binding exposes a harness as engine-drivable pieces so airlock owns the loop.
`control_mode` declares how much of the loop airlock can own:

  stub, openai            OWN   — real planner+tools; the engine drives the model
  langgraph, claude       WRAP  — OWN-capable; run as WRAP until native-seam bindings land
  smolagents, crewai,     WRAP  — opaque frameworks; the engine intercepts tool dispatch
  openai-agents
  custom                  OWN if the callable implements Planner, else WRAP (terminal)

The framework bindings reuse the legacy `drive(agent, messages)` functions as their
`run_wrapped` body, so they stay importable without the framework installed (import
is lazy, inside the method). The stub and openai bindings are the fully-owned path
the functional tests exercise.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from ..adapter import AgentRunResult, Binding, ControlMode, Dispatch
from ..engine.planner import Planner

# Legacy driver type (used as the run_wrapped body for framework bindings).
Driver = Callable[[Any, list[dict]], AgentRunResult]


class LegacyWrapBinding:
    """Wrap a legacy `drive(agent, messages) -> AgentRunResult` as a WRAP binding.

    The framework runs its own loop; we can't intercept its internal tool dispatch
    without per-framework work, so for these the control surface is currently
    terminal (observe the final result). Tool-dispatch interception for each
    framework is a documented follow-up; stub/openai give the real owned loop.
    """

    control_mode = ControlMode.WRAP

    def __init__(self, driver: Driver, agent: Any) -> None:
        self._driver = driver
        self._agent = agent

    def tools(self) -> dict[str, Any]:
        return {}

    def planner(self) -> Any:
        raise NotImplementedError("framework binding is WRAP")

    def assemble_prompt(self, messages: list[dict[str, Any]]) -> Any:
        return messages

    def run_wrapped(self, messages: list[dict[str, Any]], dispatch: Dispatch) -> AgentRunResult:
        return self._driver(self._agent, messages)


def _legacy_driver(name: str) -> Driver:
    """Import a legacy driver module lazily so frameworks need not be installed."""
    from importlib import import_module

    mod = import_module(f".{name}", __package__)
    return mod.drive


@dataclass(frozen=True)
class BindingSpec:
    control_mode: ControlMode
    reentrant: bool  # legacy: matters only for the shared-instance fallback


# Per-harness metadata (control_mode is frozen contract C1).
SPECS: dict[str, BindingSpec] = {
    "stub": BindingSpec(ControlMode.OWN, reentrant=True),
    "openai": BindingSpec(ControlMode.OWN, reentrant=True),
    "smolagents": BindingSpec(ControlMode.WRAP, reentrant=False),
    "langgraph": BindingSpec(ControlMode.WRAP, reentrant=True),
    "crewai": BindingSpec(ControlMode.WRAP, reentrant=False),
    "openai-agents": BindingSpec(ControlMode.WRAP, reentrant=True),
    "claude": BindingSpec(ControlMode.WRAP, reentrant=True),
    "custom": BindingSpec(ControlMode.OWN, reentrant=False),  # OWN if entrypoint is a Planner
}

_LEGACY_NAMES = {"smolagents", "langgraph", "crewai", "openai-agents", "claude"}


def control_mode(harness: str) -> ControlMode:
    spec = SPECS.get(harness)
    if spec is None:
        raise ValueError(f"unknown harness '{harness}'. Known: {', '.join(SPECS)}")
    return spec.control_mode


def is_reentrant(harness: str) -> bool:
    spec = SPECS.get(harness)
    return bool(spec and spec.reentrant)


def build_binding(
    harness: str,
    messages: list[dict[str, Any]],
    *,
    tools: dict[str, Any] | None = None,
    entrypoint: Any = None,
) -> Binding:
    """Construct a per-request Binding for `harness`."""
    if harness == "stub":
        from .stub import StubBinding

        return StubBinding(messages, tools)
    if harness == "openai":
        from .openai import OpenAIBinding

        return OpenAIBinding(messages, tools)
    if harness == "custom":
        # A callable that implements Planner → OWN; otherwise a terminal WRAP.
        if isinstance(entrypoint, Planner):
            return entrypoint  # type: ignore[return-value]
        from .custom import drive as custom_drive

        return LegacyWrapBinding(custom_drive, entrypoint)
    if harness in _LEGACY_NAMES:
        return LegacyWrapBinding(_legacy_driver(harness.replace("-", "_")), entrypoint)
    raise ValueError(f"unknown harness '{harness}'. Known: {', '.join(SPECS)}")


# ---- back-compat shims (older imports/tests) --------------------------------


def get_driver(harness: str) -> Driver:
    if harness in _LEGACY_NAMES or harness == "custom":
        return _legacy_driver(harness.replace("-", "_"))
    raise ValueError(f"no legacy driver for '{harness}'")
