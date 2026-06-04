"""The run integration point — assemble a RunContext from a Manifest and execute.

This is where the engine seams meet the consumer epics: policy (02), routing &
fallback (03), tool-result cache + snapshots (04), sandbox (06), trace/stream (05),
and input/output shaping (13). Per-call isolation (ADR-0010): a fresh binding and
RunContext are built for every request.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from typing import Any, Callable

from . import io as shaping
from .adapter import AgentRunResult
from .engine import RunContext, StepEvent, run_loop
from .engine.policy import PolicyControlSource
from .engine.router import (
    build_select_binding,
    wrap_callers_with_fallback,
    wrap_dispatch_with_fallback,
)
from .engine.sandbox import build_sandbox_dispatch
from .harnesses import build_binding, control_mode
from .manifest import Manifest
from .state import StateStore

# Side-effecting tools are never cached (frozen contract C3 / epic 04).
NEVER_CACHE = {"send", "pay", "write", "delete", "post", "email"}


class EngineRunner:
    """Builds runs from a manifest. `run(messages, tenant, session, ...)` executes
    one agent run through the owned loop with all controls applied."""

    def __init__(self, manifest: Manifest, store: StateStore) -> None:
        self.m = manifest
        self.store = store
        self.harness = manifest.harness()
        self.tools = manifest.tools()
        self.entrypoint = self._resolve_entrypoint()
        self.controls = manifest.controls()
        self.routing = manifest.routing()
        self.io_cfg = manifest.io()
        self.sandbox_cfg = manifest.sandbox()
        self.state_cfg = manifest.state_config()
        self.pricing = manifest.pricing()
        self.fallback = manifest.block("fallback")
        self.max_steps = int(self.controls.get("max_steps") or 50)
        self.select_binding = build_select_binding(self.routing) if self.routing else None
        self.cache_tools = set((self.state_cfg.get("cache") or {}).get("tools") or [])
        self._base_callers = manifest.build_model_callers()

    def _resolve_entrypoint(self) -> Any:
        ep = self.m.entrypoint()
        if not ep:
            return None
        from .loader import load_entrypoint

        return load_entrypoint(ep)

    def _price_per_1k(self) -> float:
        default = self.pricing.get("default") or self.pricing.get("models", {}).get("default") or {}
        return float(default.get("per_1k") or default.get("usd_per_1k") or 0.0)

    def _dispatch_wrapper(self, scoped, session: str) -> Callable | None:
        """Compose: tool-result cache (04) → sandbox (06) → tool-fallback (03).
        Cache is outermost so a hit short-circuits before any sandbox spawn (C3)."""
        sandbox = build_sandbox_dispatch(self.sandbox_cfg)

        def base(tool: Callable, name: str, args: dict) -> Any:
            if sandbox is not None:
                return sandbox(tool, name, args)
            try:
                return tool(**args)
            except TypeError:
                return tool(args)

        inner = base
        if self.fallback.get("tools"):
            inner = wrap_dispatch_with_fallback(base, self.fallback, self.tools)

        def with_cache(tool: Callable, name: str, args: dict) -> Any:
            cacheable = name in self.cache_tools and name not in NEVER_CACHE
            if not cacheable:
                return inner(tool, name, args)
            key = f"{session}/cache/{_tool_hash(name, args)}"
            hit = scoped.get(key)
            if hit is not None and isinstance(hit, dict) and "v" in hit:
                return hit["v"]
            result = inner(tool, name, args)
            scoped.set(key, {"v": result}, ttl_s=(self.state_cfg.get("cache") or {}).get("ttl_s"))
            return result

        return with_cache

    def run(
        self,
        messages: list[dict[str, Any]],
        *,
        tenant: str = "default",
        session: str = "default",
        run_id: str | None = None,
        on_step: Callable[[StepEvent], None] | None = None,
    ) -> AgentRunResult:
        # Input guard (epic 13) — before any model call.
        shaping.guard_input(messages, self.io_cfg.get("input_guards"))

        run_id = run_id or f"run_{uuid.uuid4().hex[:12]}"
        scoped = self.store.scoped(tenant)
        binding = build_binding(self.harness, messages, tools=self.tools, entrypoint=self.entrypoint)

        # Model callers (+ epic-03 fallback) — OWN only (WRAP has no engine model calls).
        callers = wrap_callers_with_fallback(dict(self._base_callers), self.fallback)

        # Trace persistence (epic 05) + forward to live stream.
        def step_sink(ev: StepEvent) -> None:
            try:
                red = shaping.redact(ev.output) if isinstance(ev.output, str) else ev.output
                scoped.snapshot(f"{session}/{run_id}/trace/{ev.index}", {**ev.to_dict(), "output": red})
            except Exception:
                pass
            if on_step is not None:
                on_step(ev)

        def snapshot(i: int, history: list[StepEvent]) -> None:
            scoped.snapshot(f"{session}/{run_id}/checkpoint/{i}", [e.to_dict() for e in history])

        ctx = RunContext(
            run_id=run_id, session=session, tenant=tenant, max_steps=self.max_steps,
            models=callers,
            control_source=PolicyControlSource(
                self.controls, run_id=run_id, store=scoped,
                price_per_1k=self._price_per_1k(),
                approval_window_s=float(self.controls.get("approval_window_s") or 0),
            ),
            select_binding=self.select_binding,
            dispatch_wrapper=self._dispatch_wrapper(scoped, session),
            on_step=step_sink,
            snapshot=snapshot,
        )
        result = run_loop(binding, messages, ctx)

        # Output enforcement (epic 13): redact + optional one repair, then return.
        content, ok = shaping.enforce_output(result.content, self.io_cfg)
        if not ok and control_mode(self.harness).value == "own":
            repair = messages + [{"role": "user", "content": "Return ONLY valid JSON, nothing else."}]
            repaired = run_loop(
                build_binding(self.harness, repair, tools=self.tools, entrypoint=self.entrypoint),
                repair, ctx,
            )
            content, ok = shaping.enforce_output(repaired.content, self.io_cfg)
        result.content = content
        return result


def _tool_hash(name: str, args: dict) -> str:
    blob = json.dumps({"n": name, "a": args}, sort_keys=True, default=str)
    return hashlib.sha256(blob.encode()).hexdigest()[:16]
