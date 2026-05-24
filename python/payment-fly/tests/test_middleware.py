from __future__ import annotations

import base64
import json
from typing import Optional
from unittest.mock import AsyncMock

import pytest
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from airlock_deploy_payment import (
    PaymentMiddleware,
    SettleResponse,
    VerifyResponse,
    parse_payment_config,
)

WALLET = "0x1234567890abcdef1234567890abcdef12345678"


def flat_config(**overrides):
    base = {"mode": "flat", "wallet": WALLET, "priceUsdc": "0.01"}
    base.update(overrides)
    return parse_payment_config(base)


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
    payload = {
        "x402Version": 1,
        "scheme": "exact",
        "network": "base",
        "payload": {"signature": "0xdeadbeef", "from": "0xpayer"},
    }
    return base64.b64encode(json.dumps(payload).encode()).decode()


def make_facilitator(
    verify: Optional[VerifyResponse] = None,
    settle: Optional[SettleResponse] = None,
):
    facilitator = AsyncMock()
    facilitator.verify = AsyncMock(
        return_value=verify or VerifyResponse(is_valid=True, payer="0xpayer")
    )
    facilitator.settle = AsyncMock(
        return_value=settle
        or SettleResponse(success=True, transaction="0xabc", network="base", payer="0xpayer")
    )
    return facilitator


async def _ok_handler(request):
    return JSONResponse({"ok": True}, status_code=200)


def make_client(config, facilitator):
    app = Starlette(routes=[Route("/run", _ok_handler, methods=["POST"])])
    app.add_middleware(PaymentMiddleware, config=config, facilitator=facilitator)
    return TestClient(app)


def test_bypasses_when_enabled_false():
    facilitator = make_facilitator()
    client = make_client(flat_config(enabled=False), facilitator)

    res = client.post("/run")

    assert res.status_code == 200
    facilitator.verify.assert_not_awaited()


def test_returns_402_when_x_payment_missing():
    facilitator = make_facilitator()
    client = make_client(flat_config(), facilitator)

    res = client.post("/run")

    assert res.status_code == 402
    body = res.json()
    assert body["x402Version"] == 1
    assert len(body["accepts"]) == 1
    facilitator.verify.assert_not_awaited()


def test_returns_402_when_x_payment_malformed():
    facilitator = make_facilitator()
    client = make_client(flat_config(), facilitator)

    res = client.post("/run", headers={"x-payment": "not-base64-json!!!"})

    assert res.status_code == 402
    assert "malformed" in res.json()["error"].lower()


def test_returns_402_when_facilitator_rejects():
    facilitator = make_facilitator(
        verify=VerifyResponse(is_valid=False, invalid_reason="bad signature")
    )
    client = make_client(flat_config(), facilitator)

    res = client.post("/run", headers={"x-payment": valid_payment_header()})

    assert res.status_code == 402
    assert "bad signature" in res.json()["error"]


def test_runs_handler_and_attaches_settlement_header_on_success():
    facilitator = make_facilitator()
    client = make_client(flat_config(), facilitator)

    res = client.post("/run", headers={"x-payment": valid_payment_header()})

    assert res.status_code == 200
    assert res.json() == {"ok": True}
    facilitator.settle.assert_awaited_once()
    assert res.headers.get("X-PAYMENT-RESPONSE")


def test_returns_402_if_settle_fails():
    facilitator = make_facilitator(
        settle=SettleResponse(success=False, error_reason="on-chain revert")
    )
    client = make_client(flat_config(), facilitator)

    res = client.post("/run", headers={"x-payment": valid_payment_header()})

    assert res.status_code == 402
    assert "on-chain revert" in res.json()["error"]


def test_per_token_mode_returns_501():
    client = make_client(per_token_config(), make_facilitator())

    res = client.post("/run")

    assert res.status_code == 501
    assert "per_token" in res.json()["error"]
