from __future__ import annotations

import pytest

from airlock_deploy_payment import build_payment_required, parse_payment_config
from airlock_deploy_payment.envelope import usdc_to_atomic

WALLET = "0x1234567890abcdef1234567890abcdef12345678"


@pytest.mark.parametrize(
    "usdc,atomic",
    [
        ("0", "0"),
        ("0.01", "10000"),
        ("1", "1000000"),
        ("1.5", "1500000"),
        ("0.000001", "1"),
        ("100", "100000000"),
    ],
)
def test_usdc_to_atomic(usdc: str, atomic: str):
    assert usdc_to_atomic(usdc) == atomic


def test_envelope_flat_mode():
    cfg = parse_payment_config({"mode": "flat", "wallet": WALLET, "priceUsdc": "0.05"})
    env = build_payment_required(cfg, "https://my-agent.fly.dev/predict")
    body = env.to_dict()
    assert body["x402Version"] == 1
    assert len(body["accepts"]) == 1
    req = body["accepts"][0]
    assert req["scheme"] == "exact"
    assert req["network"] == "base"
    assert req["maxAmountRequired"] == "50000"
    assert req["resource"] == "https://my-agent.fly.dev/predict"
    assert req["payTo"] == WALLET
    assert "error" not in body


def test_envelope_per_token_mode_uses_min_credit_balance():
    cfg = parse_payment_config(
        {
            "mode": "per_token",
            "wallet": WALLET,
            "pricePerTokenUsdc": "0.000001",
            "minCreditBalanceUsdc": "0.50",
        }
    )
    env = build_payment_required(cfg, "https://my-agent.fly.dev/chat")
    body = env.to_dict()
    req = body["accepts"][0]
    assert req["maxAmountRequired"] == "500000"
    assert req["extra"] == {"mode": "per_token_topup"}
    assert "credit balance" in body["error"].lower()
