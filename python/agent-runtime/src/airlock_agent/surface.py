"""The OpenAI-compatible chat surface — written ONCE, reused by every Harness.

`POST /v1/chat/completions` → run the adapter (the Harness's full native loop)
→ return a standard chat completion. The airlock-config Bundle is served if
present. Adding a new Harness means writing a small adapter, not touching this
file. See ADR-0007.
"""

from __future__ import annotations

import asyncio
import json
import math
import time
import uuid
from typing import Any, AsyncIterator

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.concurrency import run_in_threadpool

from .adapter import AgentRunResult, HarnessAdapter
from .concurrency import BoundedGate, QueueFull
from .wellknown import mount_wellknown, read_contract_metadata

# Heartbeat cadence while a run is in flight — short enough to stay under the
# idle-connection timeouts of Cloudflare/load balancers, so long agent loops
# don't get their stream dropped.
HEARTBEAT_S = 12.0


def _chunk(
    chunk_id: str,
    created: int,
    model: str,
    *,
    delta: dict[str, Any] | None = None,
    finish_reason: str | None = None,
    usage: dict[str, int] | None = None,
    error: str | None = None,
) -> str:
    """One OpenAI `chat.completion.chunk` as an SSE `data:` frame."""
    obj: dict[str, Any] = {
        "id": chunk_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{"index": 0, "delta": delta or {}, "finish_reason": finish_reason}],
    }
    if usage is not None:
        obj["usage"] = usage
    if error is not None:
        obj["error"] = error
    return f"data: {json.dumps(obj)}\n\n"


async def _stream_run(
    gate: BoundedGate,
    adapter: HarnessAdapter,
    messages: list[dict[str, Any]],
    model: str,
) -> AsyncIterator[str]:
    """Tier A streaming: emit an immediate role frame, heartbeat while the (sync)
    Harness loop runs in the threadpool, then the final content + a `usage` frame.
    TTFB drops to ~0 and the connection stays warm; the gate slot is held for the
    whole run and released as soon as the loop finishes. The caller `gate` MUST be
    already acquired — this generator owns releasing it exactly once."""
    chunk_id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
    created = int(time.time())
    task: asyncio.Future = asyncio.ensure_future(run_in_threadpool(adapter.run, messages))
    # Retrieve the result/exception even if the client disconnects, so a finished
    # background run doesn't log "exception never retrieved".
    task.add_done_callback(lambda t: t.cancelled() or t.exception())
    released = False

    def _release() -> None:
        nonlocal released
        if not released:
            released = True
            gate.release()

    try:
        yield _chunk(chunk_id, created, model, delta={"role": "assistant"})
        while True:
            done, _ = await asyncio.wait({task}, timeout=HEARTBEAT_S)
            if task in done:
                break
            yield ": keepalive\n\n"  # SSE comment — keeps the pipe alive, ignored by clients
        result: AgentRunResult = task.result()
    except Exception as exc:  # run failed after headers were already flushed
        _release()
        yield _chunk(chunk_id, created, model, finish_reason="stop", error=str(exc))
        yield "data: [DONE]\n\n"
        return
    finally:
        _release()

    yield _chunk(chunk_id, created, model, delta={"content": result.content})
    usage = {
        "prompt_tokens": result.prompt_tokens,
        "completion_tokens": result.completion_tokens,
        "total_tokens": result.units,
    }
    yield _chunk(chunk_id, created, model, finish_reason="stop", usage=usage)
    yield "data: [DONE]\n\n"


def _usage_of(result: AgentRunResult) -> dict[str, int]:
    return {
        "prompt_tokens": result.prompt_tokens,
        "completion_tokens": result.completion_tokens,
        "total_tokens": result.units,
    }


async def _stream_run_native(
    gate: BoundedGate,
    adapter: Any,
    messages: list[dict[str, Any]],
    model: str,
) -> AsyncIterator[str]:
    """Tier B streaming: pump a harness's own (sync, blocking) token/step stream
    out as deltas as they're produced. `adapter.run_stream(messages)` yields `str`
    deltas and finally one `AgentRunResult` (for usage). The blocking iterator runs
    in a thread and feeds an async queue; if no delta arrives within HEARTBEAT_S we
    emit a keepalive. Falls back to Tier A semantics when no delta is produced."""
    chunk_id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
    created = int(time.time())
    queue: asyncio.Queue = asyncio.Queue()
    loop = asyncio.get_running_loop()
    sentinel = object()

    def _produce() -> None:
        try:
            for item in adapter.run_stream(messages):
                loop.call_soon_threadsafe(queue.put_nowait, item)
        except Exception as exc:  # propagate to the async side
            loop.call_soon_threadsafe(queue.put_nowait, exc)
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, sentinel)

    task: asyncio.Future = asyncio.ensure_future(run_in_threadpool(_produce))
    task.add_done_callback(lambda t: t.cancelled() or t.exception())
    released = False

    def _release() -> None:
        nonlocal released
        if not released:
            released = True
            gate.release()

    final: AgentRunResult | None = None
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
            if isinstance(item, Exception):
                raise item
            if isinstance(item, AgentRunResult):
                final = item
                continue
            yield _chunk(chunk_id, created, model, delta={"content": str(item)})
    except Exception as exc:
        _release()
        yield _chunk(chunk_id, created, model, finish_reason="stop", error=str(exc))
        yield "data: [DONE]\n\n"
        return
    finally:
        _release()

    usage = _usage_of(final) if final is not None else None
    yield _chunk(chunk_id, created, model, finish_reason="stop", usage=usage)
    yield "data: [DONE]\n\n"


def to_chat_completion(result: AgentRunResult, model: str) -> dict[str, Any]:
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:24]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": result.content},
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": result.prompt_tokens,
            "completion_tokens": result.completion_tokens,
            "total_tokens": result.units,
        },
    }


def create_app(
    adapter: HarnessAdapter,
    *,
    name: str = "airlock-agent",
    dist_dir: str = "dist",
    max_concurrency: int = 1,
    max_queue: int = 0,
    queue_timeout_s: float = 30.0,
    max_wait_s: float | None = None,
) -> FastAPI:
    app = FastAPI(title=name)
    metadata = read_contract_metadata(dist_dir)

    def _ensure_gate() -> BoundedGate:
        # Lazily built on the running loop (first request) so the semaphore binds
        # to the right loop without depending on startup events firing — which
        # they don't under a plain (non-context-manager) TestClient.
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

    @app.get("/")
    def info() -> dict[str, Any]:
        gate = getattr(app.state, "run_gate", None)
        concurrency: dict[str, Any] = {"max": max_concurrency, "queue": max_queue}
        if gate is not None:
            concurrency["live"] = gate.stats()
        return {
            "name": name,
            "shape": "openai",
            "endpoints": ["POST /v1/chat/completions"],
            "concurrency": concurrency,
            "discovery": "/.well-known/airlock-config.yaml" if metadata is not None else None,
            "contract": metadata,
        }

    @app.get("/healthz")
    def healthz() -> dict[str, bool]:
        return {"ok": True}

    @app.get("/metrics")
    def metrics() -> dict[str, Any]:
        # Run-gate saturation: lets an operator (or a Cloudflare LB health check)
        # see whether this box is at capacity. Gate is built on the first request.
        gate = getattr(app.state, "run_gate", None)
        return gate.stats() if gate is not None else {"running": 0, "waiting": 0, "pending": 0}

    async def chat(request: Request):
        body = await request.json()
        messages = body.get("messages") or []
        model = body.get("model") or name
        wants_stream = bool(body.get("stream"))
        gate = _ensure_gate()
        # Admission is synchronous so 429s happen here (not mid-stream): up to N
        # run in parallel, the rest queue (FIFO), and callers whose estimated wait
        # exceeds the budget are shed with 429 + Retry-After.
        try:
            await gate.acquire()
        except (QueueFull, asyncio.TimeoutError) as exc:
            retry_after = getattr(exc, "retry_after", 0.0) or gate.stats().get("est_wait_s", 0.0)
            headers = {"Retry-After": str(int(math.ceil(retry_after)))} if retry_after > 0 else {}
            return JSONResponse(
                {"error": "agent at capacity, retry shortly"},
                status_code=429,
                headers=headers,
            )

        # The Harness's full native loop is sync, so it runs in the threadpool
        # either way; streaming just emits a heartbeat while it runs so the
        # caller sees first-byte immediately instead of after the whole loop.
        if wants_stream:
            # Tier B (real incremental deltas) when the harness exposes a stream;
            # otherwise Tier A (heartbeat + final). Either way the gate is held
            # for the whole run and released by the generator.
            generator = (
                _stream_run_native(gate, adapter, messages, model)
                if hasattr(adapter, "run_stream")
                else _stream_run(gate, adapter, messages, model)
            )
            return StreamingResponse(
                generator,
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
            )

        try:
            result: AgentRunResult = await run_in_threadpool(adapter.run, messages)
        finally:
            gate.release()
        headers: dict[str, str] = {}
        if result.units and result.units > 0:
            # Token-usage accounting header (observability only).
            headers["X-Airlock-Units"] = str(result.units)
        return JSONResponse(to_chat_completion(result, model), headers=headers)

    app.add_api_route("/v1/chat/completions", chat, methods=["POST"])
    app.add_api_route("/chat", chat, methods=["POST"])  # short alias

    # Discovery: serve the Bundle's well-known files if the Publisher built one.
    mount_wellknown(app, dist_dir)

    return app
