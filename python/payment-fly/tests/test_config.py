from __future__ import annotations

import pytest

from airlock_payment import (
    FlatPaymentConfig,
    PerTokenPaymentConfig,
    USDC_ADDRESSES,
    parse_payment_config,
    resolve_asset,
)

WALLET = "0x1234567890abcdef1234567890abcdef12345678"


def test_flat_config_minimal_with_defaults():
    cfg = parse_payment_config({"mode": "flat", "wallet": WALLET, "priceUsdc": "0.01"})
    assert isinstance(cfg, FlatPaymentConfig)
    assert cfg.enabled is True
    assert cfg.network == "base"
    assert cfg.price_usdc == "0.01"
    assert str(cfg.facilitator_url) == "https://facilitator.x402.org/"


def test_per_token_config_minimal():
    cfg = parse_payment_config(
        {
            "mode": "per_token",
            "wallet": WALLET,
            "pricePerTokenUsdc": "0.000001",
            "minCreditBalanceUsdc": "0.10",
        }
    )
    assert isinstance(cfg, PerTokenPaymentConfig)
    assert cfg.price_per_token_usdc == "0.000001"
    assert cfg.min_credit_balance_usdc == "0.10"


def test_rejects_non_evm_wallet():
    with pytest.raises(Exception):
        parse_payment_config({"mode": "flat", "wallet": "not-an-address", "priceUsdc": "0.01"})


def test_rejects_negative_or_non_numeric_price():
    with pytest.raises(Exception):
        parse_payment_config({"mode": "flat", "wallet": WALLET, "priceUsdc": "-1"})
    with pytest.raises(Exception):
        parse_payment_config({"mode": "flat", "wallet": WALLET, "priceUsdc": "free"})


def test_rejects_unknown_network():
    with pytest.raises(Exception):
        parse_payment_config(
            {"mode": "flat", "wallet": WALLET, "priceUsdc": "0.01", "network": "arbitrum-one"}
        )


def test_rejects_unknown_mode():
    with pytest.raises(ValueError):
        parse_payment_config({"mode": "whatever", "wallet": WALLET})


def test_resolve_asset_defaults_to_usdc_for_network():
    cfg = parse_payment_config(
        {"mode": "flat", "wallet": WALLET, "priceUsdc": "0.01", "network": "base-sepolia"}
    )
    assert resolve_asset(cfg) == USDC_ADDRESSES["base-sepolia"]


def test_resolve_asset_honors_explicit_override():
    explicit = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"
    cfg = parse_payment_config(
        {"mode": "flat", "wallet": WALLET, "priceUsdc": "0.01", "asset": explicit}
    )
    assert resolve_asset(cfg) == explicit
