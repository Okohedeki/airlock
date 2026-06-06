"""Mid-run routing & fallback — epic 03 (in-loop, NOT the fleet router).

This selects the model binding per step and swaps to a backup on failure, all
inside one worker's loop. Distinct from the cross-worker Fleet Router (epic 09).

Frozen contract C1: mid-run MODEL routing and MODEL-failure fallback are OWN-only
(the engine must own the model calls). TOOL-failure fallback is WRAP-ok (it wraps
tool dispatch). Role resolution precedence (locked): explicit planner tag on the
ModelCall > step type > the tool being called.

`routing` block:  {default: "default", by_role: {code: "fast", ...}}
`fallback` block: {models: {default: ["backup"]}, tools: {search: ["search_alt"]}, retries: 2}
"""

from __future__ import annotations

from typing import Any, Callable

from .planner import ModelCall


def build_select_binding(routing: dict[str, Any]) -> Callable[[ModelCall], str]:
    default = str(routing.get("default") or "default")
    by_role = dict(routing.get("by_role") or {})

    def select(action: ModelCall) -> str:
        if action.binding:  # explicit binding on the call wins
            return action.binding
        role = getattr(action, "role", None)
        if role and role in by_role:
            return by_role[role]
        return default

    return select


def wrap_callers_with_fallback(
    callers: dict[str, Callable], fallback: dict[str, Any]
) -> dict[str, Callable]:
    """Wrap each model caller so a failure retries then swaps to a backup binding.
    OWN-only — the engine owns the model call, so it can re-issue it on a backup."""
    retries = int(fallback.get("retries") or 1)
    chains = dict(fallback.get("models") or {})
    if not chains and retries <= 1:
        return callers

    wrapped: dict[str, Callable] = {}
    for name, caller in callers.items():
        wrapped[name] = _with_model_fallback(name, callers, chains, retries)
    return wrapped


def _with_model_fallback(name, callers, chains, retries):
    def call(messages):
        attempts = [name] + list(chains.get(name) or [])
        last_exc: Exception | None = None
        for binding in attempts:
            target = callers.get(binding)
            if target is None:
                continue
            for _ in range(retries):
                try:
                    return target(messages)
                except Exception as exc:  # retry, then fall through to next binding
                    last_exc = exc
        raise last_exc or RuntimeError(f"all model bindings failed for '{name}'")

    return call


def wrap_dispatch_with_fallback(
    inner: Callable[[Callable[..., Any], str, dict], Any],
    fallback: dict[str, Any],
    tools: dict[str, Callable],
) -> Callable[[Callable[..., Any], str, dict], Any]:
    """Wrap tool dispatch so a failing tool retries then tries a backup tool.
    WRAP-ok — operates purely at the tool-dispatch boundary."""
    retries = int(fallback.get("retries") or 1)
    chains = dict(fallback.get("tools") or {})

    def dispatch(tool: Callable[..., Any], name: str, args: dict) -> Any:
        attempts = [(name, tool)] + [(alt, tools.get(alt)) for alt in chains.get(name, [])]
        last_exc: Exception | None = None
        for tname, tfn in attempts:
            if tfn is None:
                continue
            for _ in range(retries):
                try:
                    return inner(tfn, tname, args)
                except Exception as exc:
                    last_exc = exc
        raise last_exc or RuntimeError(f"all tool fallbacks failed for '{name}'")

    return dispatch
