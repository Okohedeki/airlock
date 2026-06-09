"""The OpenAI-compatible chat surface — written once, reused by every harness.

`POST /v1/chat/completions` runs the agent through the Airlock Loop Engine (airlock
owns the loop, ADR-0014). With `"stream": true` the surface emits live StepEvents as
SSE `event: step` frames (epic 05) interleaved with standard OpenAI `data:` chunks,
so a watcher sees each model call / tool call / result as it happens. Approval routes
(epic 02) and typed `/skills/<id>` dispatch (epic 13) live here too.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import time
import uuid
from typing import Any, AsyncIterator, Callable, Optional

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse
from starlette.concurrency import run_in_threadpool

from .adapter import AgentRunResult
from .concurrency import BoundedGate, QueueFull
from .engine.events import StepEvent
from .io import InputRejected
from .wellknown import mount_wellknown, read_contract_metadata

HEARTBEAT_S = 12.0


def _chunk(chunk_id, created, model, *, delta=None, finish_reason=None, usage=None, error=None) -> str:
    obj: dict[str, Any] = {
        "id": chunk_id, "object": "chat.completion.chunk", "created": created, "model": model,
        "choices": [{"index": 0, "delta": delta or {}, "finish_reason": finish_reason}],
    }
    if usage is not None:
        obj["usage"] = usage
    if error is not None:
        obj["error"] = error
    return f"data: {json.dumps(obj)}\n\n"


def _step_frame(ev: StepEvent) -> str:
    """A live StepEvent as a named SSE event (epic 05). Plain OpenAI clients ignore
    non-`data:` events, so this is additive."""
    return f"event: step\ndata: {json.dumps(ev.to_dict())}\n\n"


def to_chat_completion(result: AgentRunResult, model: str, *, include_steps: bool = False) -> dict:
    out = {
        "id": f"chatcmpl-{uuid.uuid4().hex[:24]}", "object": "chat.completion",
        "created": int(time.time()), "model": model,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": result.content},
                     "finish_reason": "stop"}],
        "usage": {"prompt_tokens": result.prompt_tokens, "completion_tokens": result.completion_tokens,
                  "total_tokens": result.units},
    }
    if include_steps and result.steps is not None:
        out["steps"] = result.steps
    return out


async def _stream_engine(gate, run_call, messages, model, *, send_steps: bool) -> AsyncIterator[str]:
    """Run the engine in the threadpool; pump StepEvents (optional) + final content."""
    chunk_id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
    created = int(time.time())
    queue: asyncio.Queue = asyncio.Queue()
    loop = asyncio.get_running_loop()
    sentinel = object()

    def on_step(ev: StepEvent) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, ("step", ev))

    def _produce() -> None:
        try:
            result = run_call(messages, on_step if send_steps else None)
            loop.call_soon_threadsafe(queue.put_nowait, ("done", result))
        except Exception as exc:
            loop.call_soon_threadsafe(queue.put_nowait, ("error", exc))
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, sentinel)

    task: asyncio.Future = asyncio.ensure_future(run_in_threadpool(_produce))
    task.add_done_callback(lambda t: t.cancelled() or t.exception())
    released = False

    def _release():
        nonlocal released
        if not released:
            released = True
            gate.release()

    final: Optional[AgentRunResult] = None
    err: Optional[Exception] = None
    try:
        yield _chunk(chunk_id, created, model, delta={"role": "assistant"})
        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_S)
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"
                continue
            if item is sentinel:
                break
            kind, payload = item
            if kind == "step":
                yield _step_frame(payload)
            elif kind == "done":
                final = payload
            elif kind == "error":
                err = payload
    finally:
        _release()

    if err is not None:
        yield _chunk(chunk_id, created, model, finish_reason="stop", error=str(err))
        yield "data: [DONE]\n\n"
        return
    if final is not None:
        yield _chunk(chunk_id, created, model, delta={"content": final.content})
        usage = {"prompt_tokens": final.prompt_tokens, "completion_tokens": final.completion_tokens,
                 "total_tokens": final.units}
        yield _chunk(chunk_id, created, model, finish_reason="stop", usage=usage)
    yield "data: [DONE]\n\n"


def create_app(
    runner: Any,
    *,
    name: str = "airlock-agent",
    dist_dir: str = "dist",
    max_concurrency: int = 1,
    max_queue: int = 0,
    queue_timeout_s: float = 30.0,
    max_wait_s: float | None = None,
    authenticate: Callable[[Request], str] | None = None,  # epic 10: request -> tenant
) -> FastAPI:
    """`runner` exposes `run(messages, *, tenant, session, run_id, on_step) -> AgentRunResult`.
    A legacy `.run(messages)` object is adapted transparently."""
    app = FastAPI(title=name)
    metadata = read_contract_metadata(dist_dir)
    store = getattr(runner, "store", None)

    class _UnknownVariant(Exception):
        pass

    def _runner_for(request: Request):
        """Select the variant runner (composition/sharding overlay): request header /
        query wins, else the process profile (AIRLOCK_PROFILE), else the base runner."""
        v = (request.headers.get("X-Airlock-Variant")
             or request.query_params.get("variant")
             or os.environ.get("AIRLOCK_PROFILE"))
        if v and hasattr(runner, "for_variant"):
            try:
                return runner.for_variant(v)
            except ValueError as exc:
                raise _UnknownVariant(str(exc))
        return runner

    def _run_call(rnr, messages, tenant, session, run_id=None):
        def call(msgs, on_step):
            try:
                return rnr.run(msgs, tenant=tenant, session=session, run_id=run_id, on_step=on_step)
            except TypeError:  # legacy .run(messages)
                return rnr.run(msgs)
        return call

    def _ensure_gate() -> BoundedGate:
        gate = getattr(app.state, "run_gate", None)
        if gate is None:
            gate = BoundedGate(max_concurrency, max_queue, queue_timeout_s, max_wait=max_wait_s)
            app.state.run_gate = gate
            try:
                import anyio

                limiter = anyio.to_thread.current_default_thread_limiter()
                if limiter.total_tokens < max_concurrency + 1:
                    limiter.total_tokens = max_concurrency + 1
            except Exception:
                pass
        return gate

    def _tenant(request: Request, rnr: Any = None) -> str:
        # Auth follows the active variant: prefer the (variant) runner's own auth.
        if rnr is not None and hasattr(rnr, "authenticate"):
            return rnr.authenticate(request)
        if authenticate is not None:
            return authenticate(request)
        return request.headers.get("X-Airlock-Tenant", "default")

    def _session(request: Request) -> str:
        return request.headers.get("X-Airlock-Session", "default")

    @app.get("/")
    def info() -> dict[str, Any]:
        gate = getattr(app.state, "run_gate", None)
        concurrency: dict[str, Any] = {"max": max_concurrency, "queue": max_queue}
        if gate is not None:
            concurrency["live"] = gate.stats()
        return {
            "name": name, "shape": "openai",
            "endpoints": ["POST /v1/chat/completions", "POST /skills/{id}", "GET /v1/runs/held"],
            "concurrency": concurrency,
            "discovery": "/.well-known/airlock-config.yaml" if metadata is not None else None,
            "contract": metadata,
        }

    @app.get("/healthz")
    def healthz() -> dict[str, bool]:
        return {"ok": True}

    @app.get("/metrics")
    def metrics(request: Request):
        gate = getattr(app.state, "run_gate", None)
        stats = gate.stats() if gate is not None else {"running": 0, "waiting": 0, "pending": 0}
        if "prometheus" in request.headers.get("accept", "") or request.query_params.get("format") == "prom":
            lines = [f"airlock_{k} {v}" for k, v in stats.items() if isinstance(v, (int, float))]
            return PlainTextResponse("\n".join(lines) + "\n")
        return JSONResponse(stats)

    async def chat(request: Request):
        body = await request.json()
        messages = body.get("messages") or []
        model = body.get("model") or name
        wants_stream = bool(body.get("stream"))
        send_steps = bool(body.get("stream_steps", wants_stream))
        try:
            rnr = _runner_for(request)
            tenant, session = _tenant(request, rnr), _session(request)
        except PermissionError as exc:
            return JSONResponse({"error": str(exc)}, status_code=401)
        except _UnknownVariant as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        run_id = body.get("run_id") or request.headers.get("X-Airlock-Run")
        gate = _ensure_gate()
        try:
            await gate.acquire()
        except (QueueFull, asyncio.TimeoutError) as exc:
            retry_after = getattr(exc, "retry_after", 0.0) or gate.stats().get("est_wait_s", 0.0)
            headers = {"Retry-After": str(int(math.ceil(retry_after)))} if retry_after > 0 else {}
            return JSONResponse({"error": "agent at capacity, retry shortly"}, status_code=429, headers=headers)

        run_call = _run_call(rnr, messages, tenant, session, run_id)
        if wants_stream:
            return StreamingResponse(
                _stream_engine(gate, run_call, messages, model, send_steps=send_steps),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
            )
        try:
            result: AgentRunResult = await run_in_threadpool(run_call, messages, None)
        except InputRejected as exc:
            gate.release()
            return JSONResponse({"error": exc.reason}, status_code=exc.status)
        except Exception as exc:
            gate.release()
            return JSONResponse({"error": str(exc)}, status_code=500)
        finally:
            if not wants_stream:
                gate.release()
        headers: dict[str, str] = {}
        if result.units and result.units > 0:
            headers["X-Airlock-Units"] = str(result.units)
        return JSONResponse(to_chat_completion(result, model, include_steps=bool(body.get("include_steps"))), headers=headers)

    app.add_api_route("/v1/chat/completions", chat, methods=["POST"])
    app.add_api_route("/chat", chat, methods=["POST"])

    # ---- /skills/<id> typed dispatch (epic 13) ------------------------------
    async def skill(request: Request, skill_id: str):
        body = await request.json()
        text = body.get("input") if isinstance(body, dict) else None
        messages = [{"role": "user", "content": text if isinstance(text, str) else json.dumps(body)}]
        try:
            rnr = _runner_for(request)
            tenant, session = _tenant(request, rnr), _session(request)
        except PermissionError as exc:
            return JSONResponse({"error": str(exc)}, status_code=401)
        except _UnknownVariant as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        # Validate the skill against the manifest (skills = tools): unknown → 404,
        # disabled → 403. Only enforced when the worker declares skills.
        if hasattr(rnr, "skill_enabled") and rnr.skills:
            enabled = rnr.skill_enabled(skill_id)
            if enabled is None:
                return JSONResponse({"error": f"unknown skill '{skill_id}'"}, status_code=404)
            if not enabled:
                return JSONResponse({"error": f"skill '{skill_id}' is disabled"}, status_code=403)
        gate = _ensure_gate()
        await gate.acquire()
        run_call = _run_call(rnr, messages, tenant, session)
        try:
            result = await run_in_threadpool(run_call, messages, None)
        except InputRejected as exc:
            return JSONResponse({"error": exc.reason}, status_code=exc.status)
        finally:
            gate.release()
        return JSONResponse({"skill": skill_id, "output": result.content, "units": result.units})

    app.add_api_route("/skills/{skill_id}", skill, methods=["POST"])

    # ---- webhook triggers (epic 11) -----------------------------------------
    # A signed POST to /hooks/<path> starts a run — a trigger is just another
    # request source. Declared in worker.yaml `triggers.webhook`.
    import os as _os

    from .triggers import map_event_input, verify_hmac_sha256

    manifest = getattr(runner, "m", None)
    webhooks = (manifest.block("triggers").get("webhook") if manifest else None) or []
    for hook in webhooks:
        path = hook.get("path")
        if not path:
            continue

        def make_handler(hook_cfg):
            secret_env = hook_cfg.get("secret_env")
            mapping = hook_cfg.get("input")
            if isinstance(mapping, str):  # `input: issue.title` shorthand
                mapping = {"input": mapping}

            async def webhook(request: Request):
                raw = await request.body()
                if secret_env:
                    sig = request.headers.get("X-Hub-Signature-256") or request.headers.get("X-Signature", "")
                    secret = _os.environ.get(secret_env, "")
                    if not secret or not verify_hmac_sha256(secret, raw, sig):
                        return JSONResponse({"error": "bad signature"}, status_code=401)
                try:
                    payload = json.loads(raw or b"{}")
                except json.JSONDecodeError:
                    payload = {"body": raw.decode("utf-8", "replace")}
                text = map_event_input(payload, mapping)
                tenant = "default"
                gate = _ensure_gate()
                await gate.acquire()
                try:
                    result = await run_in_threadpool(
                        _run_call(runner, [{"role": "user", "content": text}], tenant, "default"),
                        [{"role": "user", "content": text}], None,
                    )
                finally:
                    gate.release()
                return JSONResponse({"trigger": "webhook", "output": result.content})

            return webhook

        app.add_api_route(f"/hooks/{path}", make_handler(hook), methods=["POST"])

    # ---- approval / held-run routes (epic 02) -------------------------------
    @app.get("/v1/runs/held")
    def held(request: Request):
        if store is None:
            return JSONResponse({"held": []})
        scoped = store.scoped(_tenant(request))
        out = []
        for key in scoped.list_prefix("_held/"):
            if key.count("/") == 1:  # "_held/{run}" entries, not the per-gate decisions
                v = scoped.get(key)
                if v:
                    out.append(v)
        return JSONResponse({"held": out})

    async def decide(request: Request, run_id: str):
        if store is None:
            return JSONResponse({"error": "no state store"}, status_code=400)
        body = await request.json()
        scoped = store.scoped(_tenant(request))
        held_entry = scoped.get(f"_held/{run_id}")
        if not held_entry:
            return JSONResponse({"error": "no such held run"}, status_code=404)
        gate_key = held_entry.get("gate_key") or f"_held/{run_id}/{held_entry.get('tool')}"
        scoped.set(gate_key, {"decision": body.get("decision"), "args": body.get("args"),
                              "result": body.get("result")})
        return JSONResponse({"ok": True, "run": run_id, "decision": body.get("decision")})

    app.add_api_route("/v1/runs/{run_id}/decision", decide, methods=["POST"])

    # ---- resume / fork (epic 04) --------------------------------------------
    async def resume(request: Request, run_id: str):
        if not hasattr(runner, "resume"):
            return JSONResponse({"error": "resume not supported"}, status_code=400)
        tenant = request.query_params.get("tenant", "default")
        gate = _ensure_gate()
        await gate.acquire()
        try:
            res = await run_in_threadpool(lambda: runner.resume(run_id, tenant=tenant))
        except KeyError as exc:
            return JSONResponse({"error": str(exc)}, status_code=404)
        finally:
            gate.release()
        return JSONResponse({"resumed": run_id, "content": res.content, "units": res.units})

    async def fork(request: Request, run_id: str):
        if not hasattr(runner, "fork"):
            return JSONResponse({"error": "fork not supported"}, status_code=400)
        body = await request.json()
        at_step = int(body.get("at_step", 0))
        tenant = request.query_params.get("tenant", "default")
        gate = _ensure_gate()
        await gate.acquire()
        try:
            res = await run_in_threadpool(
                lambda: runner.fork(run_id, at_step, tenant=tenant, append=body.get("append"))
            )
        except KeyError as exc:
            return JSONResponse({"error": str(exc)}, status_code=404)
        finally:
            gate.release()
        return JSONResponse({"forked": run_id, "at_step": at_step, "content": res.content})

    app.add_api_route("/v1/runs/{run_id}/resume", resume, methods=["POST"])
    app.add_api_route("/v1/runs/{run_id}/fork", fork, methods=["POST"])

    # ---- console read APIs (epic 05 / operator console) ---------------------
    @app.get("/v1/manifest")
    def manifest_view():
        m = getattr(runner, "m", None)
        if m is None:
            return JSONResponse({"name": name})
        controls = m.controls()
        tenancy = m.tenancy()
        return JSONResponse({
            "name": m.worker_name(), "version": m.worker_version(), "harness": m.harness(),
            "expose": m.expose(),
            "models": list(m.models_config().keys()),
            "tools": list((m.raw().get("tools") or {}).keys()),
            "controls": {
                "max_steps": controls.get("max_steps"),
                "budget": controls.get("budget"),
                "tool_gates": controls.get("tool_gates"),
                "approvals": [a.get("tool") for a in controls.get("approvals", [])],
            },
            "routing": m.routing(),
            "tenants": list((tenancy.get("keys") or {}).values()),  # names only, not keys
            "auth": (m.auth().get("scheme") if m.auth() else None),
        })

    def _runs_for(tenant: str) -> list[dict]:
        if store is None:
            return []
        scoped = store.scoped(tenant)
        out = []
        for key in scoped.list_prefix("_runs/"):
            v = scoped.get(key)
            if isinstance(v, dict):
                out.append(v)
        out.sort(key=lambda r: r.get("started", 0), reverse=True)
        return out

    @app.get("/v1/runs")
    def list_runs(request: Request):
        tenant = request.query_params.get("tenant", "default")
        limit = int(request.query_params.get("limit", "50"))
        runs = _runs_for(tenant)[:limit]
        summary = [{k: r.get(k) for k in
                    ("run_id", "session", "status", "stop_reason", "tokens", "n_steps", "started")}
                   for r in runs]
        return JSONResponse({"runs": summary})

    @app.get("/v1/runs/{run_id}")
    def run_detail(run_id: str, request: Request):
        tenant = request.query_params.get("tenant", "default")
        if store is None:
            return JSONResponse({"error": "no state store"}, status_code=404)
        v = store.scoped(tenant).get(f"_runs/{run_id}")
        if not v:
            return JSONResponse({"error": "no such run"}, status_code=404)
        return JSONResponse(v)

    # ---- the operator console (static, no build) ----------------------------
    from .console import mount_console

    mount_console(app)

    mount_wellknown(app, dist_dir)
    return app
