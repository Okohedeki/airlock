"""The run integration point — assemble a RunContext from a Manifest and execute.

This is where the engine seams meet the consumer epics: policy (02), routing &
fallback (03), tool-result cache + snapshots (04), sandbox (06), trace/stream (05),
and input/output shaping (13). Per-call isolation (ADR-0010): a fresh binding and
RunContext are built for every request.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
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

# Per-step logger — one line per StepEvent to stdout (docker logs); see __main__.
log = logging.getLogger("airlock_agent.run")


class EngineRunner:
    """Builds runs from a manifest. `run(messages, tenant, session, ...)` executes
    one agent run through the owned loop with all controls applied."""

    def __init__(self, manifest: Manifest, store: StateStore) -> None:
        self.m = manifest
        self.store = store
        self.harness = manifest.harness()
        self.tools = _filter_disabled_skills(manifest.tools(), manifest.skills())
        self.skills = manifest.skills()
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
        self._variants: dict[str, "EngineRunner"] = {}
        self._authn: Any = None

    def authenticate(self, request: Any) -> str:
        """Resolve the tenant for this (possibly variant-overlaid) worker's auth config.
        Variants can change auth, so auth follows the active variant (epic 10)."""
        auth = self.m.auth()
        if not auth:
            return request.headers.get("X-Airlock-Tenant", "default")
        if self._authn is None:
            from .auth import build_authenticator

            self._authn = build_authenticator(auth, self.m.tenancy(), self.store)
        return self._authn(request)

    def for_variant(self, name: str | None) -> "EngineRunner":
        """A per-variant runner (composition/sharding overlay), built + cached lazily.
        The base runner is returned for an empty/unknown-but-default name."""
        if not name:
            return self
        if name not in self._variants:
            self._variants[name] = EngineRunner(self.m.with_variant(name), self.store)
        return self._variants[name]

    def skill_enabled(self, skill_id: str) -> bool | None:
        """True/False for a declared skill, or None if the skill id is unknown."""
        s = self.skills.get(skill_id)
        return None if s is None else bool(s.get("enabled", True))

    def _resolve_entrypoint(self) -> Any:
        ep = self.m.entrypoint()
        if not ep:
            return None
        from .loader import load_entrypoint

        return load_entrypoint(ep)

    def _price_per_1k(self) -> float:
        default = self.pricing.get("default") or self.pricing.get("models", {}).get("default") or {}
        return float(default.get("per_1k") or default.get("usd_per_1k") or 0.0)

    def _prices(self) -> dict[str, float]:
        """binding name -> USD per 1k tokens, from `pricing` (epic 05 per-step cost).
        Accepts `pricing.models.<name>.per_1k` or `pricing.<name>.per_1k`."""
        out: dict[str, float] = {}
        models = self.pricing.get("models") if isinstance(self.pricing.get("models"), dict) else {}
        for name, cfg in {**self.pricing, **models}.items():
            if isinstance(cfg, dict) and ("per_1k" in cfg or "usd_per_1k" in cfg):
                out[name] = float(cfg.get("per_1k") or cfg.get("usd_per_1k") or 0.0)
        return out

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
        replay: dict[int, dict] | None = None,
    ) -> AgentRunResult:
        # Input guard (epic 13) — before any model call.
        shaping.guard_input(messages, self.io_cfg.get("input_guards"))

        run_id = run_id or f"run_{uuid.uuid4().hex[:12]}"
        scoped = self.store.scoped(tenant)
        binding = build_binding(self.harness, messages, tools=self.tools, entrypoint=self.entrypoint)

        # Give the model the schemas for the binding's ACTUAL tools (incl. framework
        # tools extracted per request), so it can emit tool_calls (tool-chaining).
        from .harnesses.openai import build_tools_schema

        tool_map = binding.tools() if hasattr(binding, "tools") else {}
        tools_schema = build_tools_schema(tool_map) if tool_map else None
        # Model callers (+ epic-03 fallback) — OWN only (WRAP has no engine model calls).
        callers = wrap_callers_with_fallback(
            self.m.build_model_callers(tools_schema=tools_schema), self.fallback)

        # Trace persistence (epic 05) + forward to live stream.
        def step_sink(ev: StepEvent) -> None:
            log.info(
                "step %d run=%s %s%s%s status=%s tokens=%d %.1fms%s",
                ev.index, run_id, ev.type.value,
                f" tool={ev.tool}" if ev.tool else "",
                f" model={ev.model}" if ev.model else "",
                ev.status.value, ev.tokens, ev.duration_ms,
                f" error={ev.error}" if ev.error else "",
            )
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
            replay=replay,
            prices=self._prices(),
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

        # Run index (epic 05 / console): a listable per-run summary with its trace.
        steps = result.steps or []
        status = "ok"
        for s in steps:
            if s.get("status") == "blocked" or s.get("stop_reason", "").startswith("AWAIT"):
                status = "blocked"
            elif s.get("status") == "killed" or s.get("stop_reason"):
                status = status if status == "blocked" else "stopped"
        scoped.set(f"_runs/{run_id}", {
            "run_id": run_id, "session": session, "tenant": tenant, "status": status,
            "tokens": result.units, "content": result.content, "steps": steps,
            "messages": messages, "started": _now(), "n_steps": len(steps),
        })
        return result

    # ---- resume / fork (epic 04) ------------------------------------------
    def _load_run(self, run_id: str, tenant: str) -> dict[str, Any]:
        entry = self.store.scoped(tenant).get(f"_runs/{run_id}")
        if not entry:
            raise KeyError(f"no such run '{run_id}'")
        return entry

    @staticmethod
    def _replay_from(steps: list[dict], up_to: int | None = None) -> dict[int, dict]:
        """Build the index→recorded map from a run's tool_result steps (OK only).
        `up_to` (fork) keeps only steps with index < up_to."""
        out: dict[int, dict] = {}
        for s in steps:
            if s.get("type") == "tool_result" and s.get("status") == "ok":
                i = int(s.get("index", -1))
                if up_to is None or i < up_to:
                    out[i] = {"tool": s.get("tool"), "output": s.get("output")}
        return out

    def resume(self, run_id: str, *, tenant: str = "default", session: str | None = None,
               on_step: Callable[[StepEvent], None] | None = None) -> AgentRunResult:
        """Re-run from the recorded run, re-feeding every recorded tool result so a
        side-effecting tool never fires twice; model calls re-run live."""
        entry = self._load_run(run_id, tenant)
        replay = self._replay_from(entry.get("steps") or [])
        return self.run(entry.get("messages") or [], tenant=tenant,
                        session=session or entry.get("session", "default"),
                        run_id=f"{run_id}-resume", on_step=on_step, replay=replay)

    def fork(self, run_id: str, at_step: int, *, tenant: str = "default",
             session: str | None = None, append: str | None = None,
             on_step: Callable[[StepEvent], None] | None = None) -> AgentRunResult:
        """Replay only steps before `at_step`, then continue live — so the run diverges
        only after step N. `append` injects one change (an extra user message)."""
        entry = self._load_run(run_id, tenant)
        replay = self._replay_from(entry.get("steps") or [], up_to=at_step)
        messages = list(entry.get("messages") or [])
        if append:
            messages = messages + [{"role": "user", "content": append}]
        return self.run(messages, tenant=tenant,
                        session=session or entry.get("session", "default"),
                        run_id=f"{run_id}-fork{at_step}", on_step=on_step, replay=replay)


def _tool_hash(name: str, args: dict) -> str:
    blob = json.dumps({"n": name, "a": args}, sort_keys=True, default=str)
    return hashlib.sha256(blob.encode()).hexdigest()[:16]


def _now() -> float:
    return time.time()


def _filter_disabled_skills(
    tools: dict[str, Callable], skills: dict[str, dict]
) -> dict[str, Callable]:
    """Drop tools that are backed ONLY by disabled skills. Tools not referenced by any
    skill, and tools backing at least one enabled skill, stay available."""
    if not skills:
        return tools
    enabled = {s["tool"] for s in skills.values() if s.get("enabled", True)}
    disabled = {s["tool"] for s in skills.values() if not s.get("enabled", True)}
    remove = disabled - enabled
    return {n: fn for n, fn in tools.items() if n not in remove}
