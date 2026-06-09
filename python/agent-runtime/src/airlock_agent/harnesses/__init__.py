"""Harness bindings, keyed by the `harness` config value (epic 01).

A Binding exposes a harness as engine-drivable pieces so airlock owns the loop.
**Built-in and framework harnesses run OWN**: airlock extracts their tools (+ prompt) and
drives them through its own loop (the OpenAI-style planner), so the full control set
applies. `custom` is OWN only if its entrypoint implements `Planner`; a plain callable is
an opaque WRAP binding that collapses to *terminal* (observe-only). Control is
feature-derived, not uniform — see CONTEXT.md (OWN / WRAP / Terminal).

  stub, openai                              real planner + tools, engine drives the model
  langgraph, smolagents, crewai,            tools extracted (harnesses/extract.py) and
  openai-agents, claude                     driven by airlock's loop — verified live for all 5
  custom                                    OWN if the entrypoint is a Planner, else terminal WRAP

The framework adapters need the framework installed (and Python >=3.10 — the base
runtime targets 3.9, but the modern agent frameworks require 3.10+). `extract.py` is
defensive across framework versions. The model that drives the loop is airlock's own
(worker.yaml `models`), so e.g. the Claude SDK harness needs no Anthropic key.
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


# Per-harness metadata (frozen contract C1). Built-in + framework harnesses are OWN;
# `custom` is OWN only with a Planner entrypoint, else a terminal WRAP binding. Control is
# feature-derived, not uniform — see CONTEXT.md (OWN / WRAP / Terminal).
SPECS: dict[str, BindingSpec] = {
    "stub": BindingSpec(ControlMode.OWN, reentrant=True),
    "openai": BindingSpec(ControlMode.OWN, reentrant=True),
    "smolagents": BindingSpec(ControlMode.OWN, reentrant=True),
    "langgraph": BindingSpec(ControlMode.OWN, reentrant=True),
    "crewai": BindingSpec(ControlMode.OWN, reentrant=True),
    "openai-agents": BindingSpec(ControlMode.OWN, reentrant=True),
    "claude": BindingSpec(ControlMode.OWN, reentrant=True),
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
    disabled: set[str] | None = None,
) -> Binding:
    """Construct a per-request Binding for `harness`. `disabled` is the set of tool
    names backed only by disabled skills — dropped from the binding's tool map so a
    disabled skill removes its tool from the loop for EXTRACTED tools too, not just
    declared ones (skills on/off is uniform across harnesses)."""
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
        # Extract the framework's tools (+ prompt) and drive them through airlock's
        # own loop: the framework contributes pieces, airlock owns the loop.
        from .extract import EXTRACTORS
        from .openai import OpenAIBinding

        extracted, prompt = EXTRACTORS[harness](entrypoint)
        merged = {**extracted, **(tools or {})}
        if disabled:
            merged = {n: f for n, f in merged.items() if n not in disabled}
        msgs = ([{"role": "system", "content": prompt}] if prompt else []) + messages
        return OpenAIBinding(msgs, merged)
    raise ValueError(f"unknown harness '{harness}'. Known: {', '.join(SPECS)}")


# ---- back-compat shims (older imports/tests) --------------------------------


def get_driver(harness: str) -> Driver:
    if harness in _LEGACY_NAMES or harness == "custom":
        return _legacy_driver(harness.replace("-", "_"))
    raise ValueError(f"no legacy driver for '{harness}'")
