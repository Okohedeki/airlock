from __future__ import annotations

import pytest

from airlock_payment import InMemoryCreditLedger, InsufficientBalanceError
from airlock_payment.ledger import _from_atomic, _to_atomic

ALICE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"


def test_atomic_roundtrip_without_drift():
    assert _from_atomic(_to_atomic("0.000001") + _to_atomic("0.000001")) == "0.000002"
    assert _from_atomic(_to_atomic("0.1") + _to_atomic("0.2")) == "0.3"
    assert _from_atomic(_to_atomic("1.000000")) == "1"
    assert _from_atomic(_to_atomic("0")) == "0"


async def test_unknown_caller_balance_is_zero():
    ledger = InMemoryCreditLedger()
    assert await ledger.get_balance(ALICE) == "0"


async def test_credit_then_balance_reflects_total():
    ledger = InMemoryCreditLedger()
    await ledger.credit(ALICE, "1.00")
    assert await ledger.get_balance(ALICE) == "1"


async def test_debit_down_to_zero():
    ledger = InMemoryCreditLedger()
    await ledger.credit(ALICE, "0.50")
    await ledger.debit(ALICE, "0.50")
    assert await ledger.get_balance(ALICE) == "0"


async def test_debit_over_balance_raises():
    ledger = InMemoryCreditLedger()
    await ledger.credit(ALICE, "0.10")
    with pytest.raises(InsufficientBalanceError):
        await ledger.debit(ALICE, "0.11")


async def test_callers_isolated():
    ledger = InMemoryCreditLedger()
    await ledger.credit(ALICE, "1.00")
    assert await ledger.get_balance(BOB) == "0"
    await ledger.credit(BOB, "0.25")
    assert await ledger.get_balance(ALICE) == "1"
    assert await ledger.get_balance(BOB) == "0.25"


async def test_many_tiny_per_token_debits():
    ledger = InMemoryCreditLedger()
    await ledger.credit(ALICE, "0.001000")
    for _ in range(1000):
        await ledger.debit(ALICE, "0.000001")
    assert await ledger.get_balance(ALICE) == "0"


async def test_sessions_round_trip_unique_per_call():
    ledger = InMemoryCreditLedger()
    a1 = await ledger.issue_session(ALICE)
    a2 = await ledger.issue_session(ALICE)
    b1 = await ledger.issue_session(BOB)
    assert a1 != a2
    assert a1 != b1
    assert await ledger.verify_session(a1) == ALICE
    assert await ledger.verify_session(a2) == ALICE
    assert await ledger.verify_session(b1) == BOB


async def test_verify_session_returns_none_for_unknown():
    ledger = InMemoryCreditLedger()
    assert await ledger.verify_session("als_bogus") is None
