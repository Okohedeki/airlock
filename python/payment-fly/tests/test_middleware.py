from __future__ import annotations

import base64
import json
from typing import Optional
from unittest.mock import AsyncMock

import pytest
from starlette.applications import Starlette
from starlette.responses import JSONResponse, Response
from starlette.routing import Route
from starlette.testclient import TestClient

from airlock_payment import (
    InMemoryCreditLedger,
    PaymentMiddleware,
    SESSION_HEADER,
    SettleResponse,
    TOKENS_USED_HEADER,
    USAGE_UNITS_HEADER,
    VerifyResponse,
    parse_payment_config,
)

WALLET = "0x1234567890abcdef1234567890abcdef12345678"
PAYER = "0xpayer000000000000000000000000000000000001"


def flat_config(**overrides):
    base = {"mode": "flat", "wallet": WALLET, "priceUsdc": "0.01"}
    base.update(overrides)
    return parse_payment_config(base)


def per_token_config(**overrides):
    base = {
        "mode": "per_token",
        "wallet": WALLET,
        "pricePerTokenUsdc": "0.000001",
        "minCreditBalanceUsdc": "0.10",
    }
    base.update(overrides)
    return parse_payment_config(base)


def valid_payment_header() -> str:
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


async def _ok_handler(request):
    return JSONResponse({"ok": True}, status_code=200)


def _tokens_handler(tokens: int):
    async def handler(request):
        return Response(
            content=json.dumps({"ok": True}),
            status_code=200,
            headers={TOKENS_USED_HEADER: str(tokens), "content-type": "application/json"},
        )

    return handler


def _units_handler(units: int):
    async def handler(request):
        return Response(
            content=json.dumps({"ok": True}),
            status_code=200,
            headers={USAGE_UNITS_HEADER: str(units), "content-type": "application/json"},
        )

    return handler


def make_client(config, handler=_ok_handler, *, facilitator=None, ledger=None):
    app = Starlette(routes=[Route("/run", handler, methods=["POST"])])
    app.add_middleware(
        PaymentMiddleware,
        config=config,
        facilitator=facilitator or make_facilitator(),
        ledger=ledger or InMemoryCreditLedger(),
    )
    return TestClient(app)


# ───────────────────────────── flat mode ─────────────────────────────


def test_flat_bypasses_when_enabled_false():
    facilitator = make_facilitator()
    client = make_client(flat_config(enabled=False), facilitator=facilitator)
    res = client.post("/run")
    assert res.status_code == 200
    facilitator.verify.assert_not_awaited()


def test_flat_returns_402_when_x_payment_missing():
    client = make_client(flat_config())
    res = client.post("/run")
    assert res.status_code == 402
    body = res.json()
    assert body["x402Version"] == 1


def test_flat_returns_402_when_x_payment_malformed():
    client = make_client(flat_config())
    res = client.post("/run", headers={"x-payment": "not-base64-json!!!"})
    assert res.status_code == 402
    assert "malformed" in res.json()["error"].lower()


def test_flat_returns_402_when_facilitator_rejects():
    facilitator = make_facilitator(
        verify=VerifyResponse(is_valid=False, invalid_reason="bad signature")
    )
    client = make_client(flat_config(), facilitator=facilitator)
    res = client.post("/run", headers={"x-payment": valid_payment_header()})
    assert res.status_code == 402
    assert "bad signature" in res.json()["error"]


def test_flat_runs_handler_and_attaches_payment_response():
    facilitator = make_facilitator()
    client = make_client(flat_config(), facilitator=facilitator)
    res = client.post("/run", headers={"x-payment": valid_payment_header()})
    assert res.status_code == 200
    facilitator.settle.assert_awaited_once()
    assert res.headers.get("X-PAYMENT-RESPONSE")


def test_flat_returns_402_if_settle_fails():
    facilitator = make_facilitator(
        settle=SettleResponse(success=False, error_reason="on-chain revert")
    )
    client = make_client(flat_config(), facilitator=facilitator)
    res = client.post("/run", headers={"x-payment": valid_payment_header()})
    assert res.status_code == 402
    assert "on-chain revert" in res.json()["error"]


# ───────────────────────────── per_token mode ─────────────────────────────


def test_per_token_returns_402_when_no_payment_and_no_session():
    client = make_client(per_token_config())
    res = client.post("/run")
    assert res.status_code == 402
    body = res.json()
    # 0.10 USDC = 100_000 atomic
    assert body["accepts"][0]["maxAmountRequired"] == "100000"


def test_per_token_topup_call_settles_credits_runs_handler_debits():
    facilitator = make_facilitator()
    ledger = InMemoryCreditLedger()
    client = make_client(
        per_token_config(),
        handler=_tokens_handler(1000),
        facilitator=facilitator,
        ledger=ledger,
    )

    res = client.post("/run", headers={"x-payment": valid_payment_header()})

    assert res.status_code == 200
    assert res.headers.get(SESSION_HEADER)
    assert res.headers.get("X-PAYMENT-RESPONSE")
    facilitator.settle.assert_awaited_once()
    # Credit 0.10, debit 1000 * 0.000001 = 0.001 → balance 0.099
    import asyncio

    assert asyncio.get_event_loop().run_until_complete(ledger.get_balance(PAYER)) == "0.099"


def test_per_token_debits_via_units_header():
    facilitator = make_facilitator()
    ledger = InMemoryCreditLedger()
    client = make_client(
        per_token_config(),
        handler=_units_handler(1000),
        facilitator=facilitator,
        ledger=ledger,
    )

    res = client.post("/run", headers={"x-payment": valid_payment_header()})
    assert res.status_code == 200
    import asyncio

    # Same 0.099 as the tokens path — units header is read identically.
    assert asyncio.get_event_loop().run_until_complete(ledger.get_balance(PAYER)) == "0.099"


def test_per_token_session_call_draws_down_without_paying():
    facilitator = make_facilitator()
    ledger = InMemoryCreditLedger()
    client = make_client(
        per_token_config(),
        handler=_tokens_handler(500),
        facilitator=facilitator,
        ledger=ledger,
    )

    first = client.post("/run", headers={"x-payment": valid_payment_header()})
    session = first.headers.get(SESSION_HEADER)
    assert session

    facilitator.verify.reset_mock()
    facilitator.settle.reset_mock()

    second = client.post("/run", headers={SESSION_HEADER: session})
    assert second.status_code == 200
    facilitator.verify.assert_not_awaited()
    facilitator.settle.assert_not_awaited()


def test_per_token_rejects_unknown_session():
    client = make_client(per_token_config())
    res = client.post("/run", headers={SESSION_HEADER: "als_bogus"})
    assert res.status_code == 402
    assert "invalid" in res.json()["error"].lower() or "expired" in res.json()["error"].lower()


def test_per_token_402_once_balance_depleted():
    config = per_token_config(minCreditBalanceUsdc="0.10", pricePerTokenUsdc="0.05")
    facilitator = make_facilitator()
    ledger = InMemoryCreditLedger()
    client = make_client(
        config, handler=_tokens_handler(1), facilitator=facilitator, ledger=ledger
    )

    first = client.post("/run", headers={"x-payment": valid_payment_header()})
    assert first.status_code == 200
    session = first.headers.get(SESSION_HEADER)

    second = client.post("/run", headers={SESSION_HEADER: session})
    assert second.status_code == 200  # drains balance to 0

    third = client.post("/run", headers={SESSION_HEADER: session})
    assert third.status_code == 402
    err = third.json()["error"].lower()
    assert "depleted" in err or "top up" in err
