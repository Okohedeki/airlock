"""The orchestrator loop — airlock owns the agent loop (ADR-0014, epic 01).

`run_loop(binding, messages, ctx)` runs:

    assemble → planner.next_action(history) → execute (model | tool | finish)
    → record StepEvent → consult ControlSignal → repeat

for OWN bindings, and routes tool dispatch through a shim for WRAP bindings. Every
consumer epic plugs in through a `RunContext` seam without the engine importing it:

    ctx.control_source   guards + approval (epic 02): gate() before a tool, evaluate() between steps
    ctx.select_binding   mid-run model routing (epic 03): pick the model caller per ModelCall
    ctx.dispatch_wrapper tool-result cache (04) + sandbox (06): wrap raw tool dispatch
    ctx.on_step          observability (epic 05): receive each StepEvent (stream/trace)
    ctx.snapshot         checkpoint/resume (epic 04): persist state after each step
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol

from ..adapter import AgentRunResult, Binding, ControlMode, Dispatch
from .events import ControlSignal, ControlSource, StepEvent, StepStatus, StepType
from .planner import Action, Finish, ModelCall, Planner, ToolCall


@dataclass
class ModelResult:
    content: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    data: Any = None  # structured payload (e.g. OpenAI tool_calls) the planner reads back
    model: str | None = None  # the actual model that served (for the StepEvent trace)

    @property
    def total(self) -> int:
        return self.prompt_tokens + self.completion_tokens


class ModelCaller(Protocol):
    """Executes a model call for an OWN binding. Named bindings live in a registry so
    epic 03 can route per step."""

    def __call__(self, messages: list[dict[str, Any]]) -> ModelResult: ...


@dataclass
class RunContext:
    """Everything a run needs, with optional seams for the consumer epics."""

    run_id: str = "run"
    session: str = "default"
    tenant: str = "default"
    max_steps: int = 50
    models: dict[str, ModelCaller] = field(default_factory=dict)  # name -> caller (epic 03/07)
    control_source: ControlSource = field(default_factory=ControlSource)  # epic 02
    select_binding: Callable[[ModelCall], str] | None = None  # epic 03 router
    dispatch_wrapper: Callable[[Callable[..., Any], str, dict], Any] | None = None  # 04/06
    on_step: Callable[[StepEvent], None] | None = None  # epic 05
    snapshot: Callable[[int, list[StepEvent]], None] | None = None  # epic 04
    replay: dict[int, dict] | None = None  # epic 04 resume/fork: idx -> recorded {tool, output}
    prices: dict[str, float] | None = None  # epic 05: binding name -> USD per 1k tokens

    def emit(self, ev: StepEvent) -> None:
        if self.on_step is not None:
            try:
                self.on_step(ev)
            except Exception:  # observability must never break a run
                pass


class _AdapterBinding:
    """Wrap a legacy `.run(messages) -> AgentRunResult` object as a degraded,
    single-step WRAP binding (back-compat for templates and the serve() helper)."""

    control_mode = ControlMode.WRAP

    def __init__(self, obj: Any) -> None:
        self._obj = obj

    def tools(self) -> dict[str, Any]:
        return {}

    def planner(self) -> Any:
        raise NotImplementedError("adapter binding is WRAP/terminal")

    def assemble_prompt(self, messages: list[dict[str, Any]]) -> Any:
        return messages

    def run_wrapped(self, messages: list[dict[str, Any]], dispatch: Dispatch) -> AgentRunResult:
        return self._obj.run(messages)


def as_binding(obj: Any) -> Binding:
    """Coerce an object to a Binding: a real Binding passes through; a legacy
    `.run()` adapter is wrapped as a degraded WRAP binding."""
    if isinstance(obj, Binding):
        return obj  # type: ignore[return-value]
    if hasattr(obj, "control_mode") and hasattr(obj, "run_wrapped"):
        return obj  # duck-typed binding
    if hasattr(obj, "run"):
        return _AdapterBinding(obj)
    raise TypeError("object is neither a Binding nor a .run(messages) adapter")


def _coerce_args(tool: Callable[..., Any], args: dict[str, Any]) -> dict[str, Any]:
    """Coerce args to the tool's annotated types — models often send numbers as
    strings (e.g. "128"), which would silently misbehave (string concat, etc.)."""
    import inspect

    if not isinstance(args, dict):
        return args
    try:
        params = inspect.signature(tool).parameters
    except (ValueError, TypeError):
        return args
    out = dict(args)
    for name, val in args.items():
        ann = params.get(name).annotation if params.get(name) else None
        try:
            if ann is int and not isinstance(val, bool):
                out[name] = int(val)
            elif ann is float:
                out[name] = float(val)
            elif ann is bool and isinstance(val, str):
                out[name] = val.strip().lower() in ("1", "true", "yes")
        except (ValueError, TypeError):
            pass
    return out


def _call_tool(tool: Callable[..., Any], args: dict[str, Any]) -> Any:
    """Dispatch a tool with dict args, tolerating both kwargs and single-arg tools."""
    try:
        return tool(**args)
    except TypeError:
        return tool(args)


def run_loop(binding: Binding, messages: list[dict[str, Any]], ctx: RunContext) -> AgentRunResult:
    binding = as_binding(binding)
    if binding.control_mode == ControlMode.OWN:
        return _run_own(binding, messages, ctx)
    return _run_wrapped(binding, messages, ctx)


def _resolve_binding_name(ctx: RunContext, action: ModelCall) -> str:
    """Which named model binding actually serves this call (epic 03 routing)."""
    if ctx.select_binding is not None:
        return ctx.select_binding(action) or "default"
    if action.binding:
        return action.binding
    return "default"


def _resolve_caller(ctx: RunContext, action: ModelCall) -> ModelCaller:
    name = _resolve_binding_name(ctx, action)
    caller = ctx.models.get(name) or ctx.models.get("default")
    if caller is None:
        raise RuntimeError(f"no model binding '{name}' registered for this run")
    return caller


def _dispatch(ctx: RunContext, tools: dict[str, Any], name: str, args: dict[str, Any]) -> Any:
    tool = tools.get(name)
    if tool is None:
        raise KeyError(f"unknown tool '{name}'")
    args = _coerce_args(tool, args)
    if ctx.dispatch_wrapper is not None:
        return ctx.dispatch_wrapper(tool, name, args)
    return _call_tool(tool, args)


def _run_own(binding: Binding, messages: list[dict[str, Any]], ctx: RunContext) -> AgentRunResult:
    planner: Planner = binding.planner()
    tools = binding.tools()
    history: list[StepEvent] = []
    total_tokens = pt = ct = 0
    idx = 0

    while idx < ctx.max_steps:
        action: Action = planner.next_action(history)

        if isinstance(action, ModelCall):
            t0 = time.monotonic()
            binding_name = _resolve_binding_name(ctx, action)
            caller = _resolve_caller(ctx, action)
            mr = caller(action.messages or messages)
            price = (ctx.prices or {}).get(binding_name, 0.0)
            ev = StepEvent(
                index=idx, type=StepType.MODEL, input=action.messages or messages,
                output=(mr.data if mr.data is not None else mr.content),
                tokens=mr.total, prompt_tokens=mr.prompt_tokens,
                completion_tokens=mr.completion_tokens,
                duration_ms=(time.monotonic() - t0) * 1000,
                cost_usd=mr.total / 1000.0 * price,
                model=(mr.model or binding_name),
            )
            total_tokens += mr.total
            pt += mr.prompt_tokens
            ct += mr.completion_tokens

        elif isinstance(action, ToolCall):
            # Resume/fork (epic 04): re-feed a recorded tool result instead of dispatching,
            # so an already-executed (possibly side-effecting) tool never fires twice.
            recorded = ctx.replay.get(idx) if ctx.replay else None
            if recorded is not None and recorded.get("tool") == action.name:
                ev = StepEvent(index=idx, type=StepType.TOOL_RESULT, tool=action.name,
                               input=action.args, output=recorded.get("output"),
                               status=StepStatus.OK, error="replayed")
                history.append(ev)
                ctx.emit(ev)
                idx += 1
                continue
            # Guard the pending tool call BEFORE dispatch (epic 02 — WRAP-ok seam).
            sig: ControlSignal = ctx.control_source.gate(action)
            if sig.action == "kill":
                ev = StepEvent(index=idx, type=StepType.TOOL_CALL, tool=action.name,
                               input=action.args, status=StepStatus.KILLED, error=sig.reason)
                history.append(ev)
                ctx.emit(ev)
                return _finish(history, "", total_tokens, pt, ct, StepStatus.KILLED)
            if sig.action == "pause":
                ev = StepEvent(index=idx, type=StepType.TOOL_CALL, tool=action.name,
                               input=action.args, status=StepStatus.BLOCKED, error=sig.reason)
                history.append(ev)
                ctx.emit(ev)
                if ctx.snapshot:
                    ctx.snapshot(idx, history)
                return _finish(history, "", total_tokens, pt, ct, StepStatus.BLOCKED)
            args = sig.override_args if (sig.action == "override" and sig.override_args) else action.args
            t0 = time.monotonic()
            if sig.action == "override" and not sig.override_args:
                # override / skip: inject the operator's result (which may legitimately
                # be None for `skip`) and do NOT run the tool. `edit` carries
                # override_args instead and falls through to a real dispatch below.
                result, status, err = sig.override_result, StepStatus.OK, None
            else:
                try:
                    result, status, err = _dispatch(ctx, tools, action.name, args), StepStatus.OK, None
                except Exception as exc:  # surfaces as a step failure → epic-03 fallback
                    result, status, err = None, StepStatus.ERROR, str(exc)
            ev = StepEvent(index=idx, type=StepType.TOOL_RESULT, tool=action.name, input=args,
                           output=result, status=status, error=err,
                           duration_ms=(time.monotonic() - t0) * 1000)

        elif isinstance(action, Finish):
            ev = StepEvent(index=idx, type=StepType.FINAL, output=action.content,
                           tokens=action.tokens, prompt_tokens=action.prompt_tokens,
                           completion_tokens=action.completion_tokens, status=StepStatus.OK)
            total_tokens += action.tokens
            pt += action.prompt_tokens
            ct += action.completion_tokens
            history.append(ev)
            ctx.emit(ev)
            if ctx.snapshot:
                ctx.snapshot(idx, history)
            return _finish(history, action.content, total_tokens, pt, ct, StepStatus.OK)

        else:  # pragma: no cover - defensive
            raise TypeError(f"planner returned unknown action {type(action)!r}")

        history.append(ev)
        ctx.emit(ev)
        if ctx.snapshot:
            ctx.snapshot(idx, history)

        # Consult control between steps (epic 02 — budget/$ stop is OWN-only).
        between: ControlSignal = ctx.control_source.evaluate(history)
        if between.action == "kill":
            return _finish(history, _last_text(history), total_tokens, pt, ct, StepStatus.KILLED,
                           reason=between.reason)
        if between.action == "pause":
            if ctx.snapshot:
                ctx.snapshot(idx, history)
            return _finish(history, _last_text(history), total_tokens, pt, ct, StepStatus.BLOCKED,
                           reason=between.reason)

        idx += 1

    # max_steps reached without a Finish.
    return _finish(history, _last_text(history), total_tokens, pt, ct, StepStatus.KILLED,
                   reason="MAX_STEPS")


def _run_wrapped(binding: Binding, messages: list[dict[str, Any]], ctx: RunContext) -> AgentRunResult:
    """WRAP path: the framework runs its own loop, but its tool dispatch routes
    through our shim so gating / approval / cache / sandbox still fire and each tool
    call emits a StepEvent. Model/state-column control is unavailable here (C1)."""
    counter = {"i": 0}

    def dispatch(name: str, args: dict[str, Any]) -> Any:
        i = counter["i"]
        counter["i"] += 1
        sig = ctx.control_source.gate(ToolCall(name=name, args=args))
        if sig.action == "kill":
            ev = StepEvent(index=i, type=StepType.TOOL_CALL, tool=name, input=args,
                           status=StepStatus.KILLED, error=sig.reason)
            ctx.emit(ev)
            raise RuntimeError(f"tool '{name}' blocked: {sig.reason}")
        use_args = sig.override_args if (sig.action == "override" and sig.override_args) else args
        if sig.action == "override" and sig.override_result is not None:
            ev = StepEvent(index=i, type=StepType.TOOL_RESULT, tool=name, input=use_args,
                           output=sig.override_result, status=StepStatus.OK)
            ctx.emit(ev)
            return sig.override_result
        t0 = time.monotonic()
        tools = binding.tools()
        try:
            result = _dispatch(ctx, tools, name, use_args) if name in tools else None
        except Exception as exc:
            ev = StepEvent(index=i, type=StepType.TOOL_RESULT, tool=name, input=use_args,
                           status=StepStatus.ERROR, error=str(exc),
                           duration_ms=(time.monotonic() - t0) * 1000)
            ctx.emit(ev)
            raise
        ev = StepEvent(index=i, type=StepType.TOOL_RESULT, tool=name, input=use_args,
                       output=result, duration_ms=(time.monotonic() - t0) * 1000)
        ctx.emit(ev)
        return result

    res = binding.run_wrapped(messages, dispatch)
    final = StepEvent(index=counter["i"], type=StepType.FINAL, output=res.content,
                      tokens=res.units, prompt_tokens=res.prompt_tokens,
                      completion_tokens=res.completion_tokens)
    ctx.emit(final)
    # Match the OWN path's contract: result.steps is a list of dicts (runner.run and
    # the trace layer call .get() on each). WRAP previously appended StepEvent objects.
    prior = [s.to_dict() if isinstance(s, StepEvent) else s for s in (res.steps or [])]
    res.steps = prior + [final.to_dict()]
    return res


def _last_text(history: list[StepEvent]) -> str:
    for ev in reversed(history):
        if ev.type in (StepType.FINAL, StepType.MODEL) and ev.output:
            return str(ev.output)
    return ""


def _finish(history: list[StepEvent], content: str, total: int, pt: int, ct: int,
            status: StepStatus, reason: str | None = None) -> AgentRunResult:
    # The stop reason belongs to the boundary (last) step only — not every step.
    steps = [ev.to_dict() for ev in history]
    if reason and steps:
        steps[-1]["stop_reason"] = reason
    return AgentRunResult(content=content, units=total, prompt_tokens=pt, completion_tokens=ct, steps=steps)
