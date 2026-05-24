from __future__ import annotations

import json
from typing import Optional
from unittest.mock import AsyncMock

import pytest
from starlette.applications import Starlette
from starlette.responses import Response
from starlette.routing import Route
from starlette.testclient import TestClient

from airlock_deploy_payment import (
    CallReporter,
    PaymentMiddleware,
    SettleResponse,
    TOKENS_USED_HEADER,
    VerifyResponse,
    parse_payment_config,
)
from airlock_deploy_payment.middleware import _encode_payment_response_header

WALLET = "0x1234567890abcdef1234567890abcdef12345678"
PAYER = "0xpayer000000000000000000000000000000000001"


def per_token_config():
    return parse_payment_config(
        {
            "mode": "per_token",
            "wallet": WALLET,
            "pricePerTokenUsdc": "0.000001",
            "minCreditBalanceUsdc": "0.10",
        }
    )


def valid_payment_header() -> str:
    import base64
    payload = {
        "x402Version": 1,
        "scheme": "exact",
        "network": "base",
        "payload": {"signature": "0xdeadbeef", "from": PAYER},
    }
    return base64.b64encode(json.dumps(payload).encode()).decode()


def make_facilitator(
    verify: Optional[VerifyResponse] = None,
    settle: Optional[SettleResponse] = None,
):
    facilitator = AsyncMock()
    facilitator.verify = AsyncMock(
        return_value=verify or VerifyResponse(is_valid=True, payer=PAYER)
    )
    facilitator.settle = AsyncMock(
        return_value=settle
        or SettleResponse(success=True, transaction="0xabc", network="base", payer=PAYER)
    )
    return facilitator


async def _tokens_handler(request):
    return Response(
        content=json.dumps({"ok": True}),
        status_code=200,
        headers={TOKENS_USED_HEADER: "1000", "content-type": "application/json"},
    )


def test_reporter_receives_call_details_after_paid_topup():
    """When configured, the reporter POSTs each call's outcome to the backend."""
    captured = []

    class FakeHttp:
        async def post(self, url, json, headers):
            captured.append({"url": url, "body": json, "headers": headers})
            return object()

    reporter = CallReporter(
        url="http://backend.test",
        token="tok",
        project_name="my-agent",
        http=FakeHttp(),
    )

    app = Starlette(routes=[Route("/run", _tokens_handler, methods=["POST"])])
    app.add_middleware(
        PaymentMiddleware,
        config=per_token_config(),
        facilitator=make_facilitator(),
        reporter=reporter,
    )
    client = TestClient(app)

    res = client.post("/run", headers={"x-payment": valid_payment_header()})
    assert res.status_code == 200

    assert len(captured) == 1
    assert captured[0]["url"] == "http://backend.test/api/inspect"
    body = captured[0]["body"]
    assert body["project_name"] == "my-agent"
    assert body["caller"] == PAYER
    assert body["status"] == 200
    assert body["tokens_used"] == 1000
    assert body["payment_settled"] is True


def test_reporter_swallows_http_errors():
    """A throwing reporter must not break the response."""

    class BrokenHttp:
        async def post(self, *args, **kwargs):
            raise RuntimeError("backend is down")

    reporter = CallReporter(
        url="http://backend.test",
        token="tok",
        project_name="my-agent",
        http=BrokenHttp(),
    )

    app = Starlette(routes=[Route("/run", _tokens_handler, methods=["POST"])])
    app.add_middleware(
        PaymentMiddleware,
        config=per_token_config(),
        facilitator=make_facilitator(),
        reporter=reporter,
    )
    client = TestClient(app)

    res = client.post("/run", headers={"x-payment": valid_payment_header()})
    assert res.status_code == 200
