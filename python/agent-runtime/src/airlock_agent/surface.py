"""The OpenAI-compatible chat surface — written ONCE, reused by every Harness.

`POST /v1/chat/completions` → run the adapter (the Harness's full native loop)
→ return a standard chat completion. Payment middleware is mounted in-process
(free by default); the airlock-config Bundle is served if present. Adding a new
Harness means writing a small adapter, not touching this file. See ADR-0007.
"""

from __future__ import annotations

import time
import uuid
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from .adapter import AgentRunResult, HarnessAdapter
from .wellknown import mount_wellknown, read_contract_metadata


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
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": result.units},
    }


def create_app(
    adapter: HarnessAdapter,
    *,
    name: str = "airlock-agent",
    payment_config: Any | None = None,
    payment_kwargs: dict[str, Any] | None = None,
    dist_dir: str = "dist",
) -> FastAPI:
    from airlock_payment import USAGE_UNITS_HEADER

    app = FastAPI(title=name)
    metadata = read_contract_metadata(dist_dir)

    @app.get("/")
    def info() -> dict[str, Any]:
        return {
            "name": name,
            "shape": "openai",
            "endpoints": ["POST /v1/chat/completions"],
            "payment": {"enabled": bool(payment_config and payment_config.enabled)},
            "discovery": "/.well-known/airlock-config.yaml" if metadata is not None else None,
            "contract": metadata,
        }

    @app.get("/healthz")
    def healthz() -> dict[str, bool]:
        return {"ok": True}

    async def chat(request: Request) -> JSONResponse:
        body = await request.json()
        messages = body.get("messages") or []
        model = body.get("model") or name
        # Run the Harness's full native loop off the event loop (adapters are sync).
        result: AgentRunResult = await run_in_threadpool(adapter.run, messages)
        headers: dict[str, str] = {}
        if result.units and result.units > 0:
            headers[USAGE_UNITS_HEADER] = str(result.units)
        return JSONResponse(to_chat_completion(result, model), headers=headers)

    app.add_api_route("/v1/chat/completions", chat, methods=["POST"])
    app.add_api_route("/chat", chat, methods=["POST"])  # short alias

    # Discovery: serve the Bundle's well-known files if the Publisher built one.
    mount_wellknown(app, dist_dir)

    # Payment wraps the chat route; health/info/discovery stay free.
    if payment_config is not None:
        from airlock_payment import PaymentMiddleware

        app.add_middleware(
            PaymentMiddleware,
            config=payment_config,
            exempt_paths=["/", "/healthz", "/.well-known"],
            **(payment_kwargs or {}),
        )

    return app
