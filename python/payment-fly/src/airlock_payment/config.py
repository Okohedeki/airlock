"""PaymentConfig — the Python mirror of the TS Zod schema in @airlockhq/payment-core.

Validated via Pydantic v2. Stays in sync with `packages/payment-core/src/config.ts` —
network keys, default facilitator, USDC contract addresses, and the flat / per_token
mode union must match exactly so a `.airlock/config.toml` works under either
Recipe.
"""

from __future__ import annotations

import re
from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, field_validator
from typing_extensions import TypeAlias

EvmAddress: TypeAlias = str

USDC_ADDRESSES: dict[str, str] = {
    # Keys mirror @x402/evm EVM_NETWORK_CHAIN_ID_MAP. Keep in sync.
    "base": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
}

SupportedNetwork: TypeAlias = Literal["base", "base-sepolia"]

_EVM_ADDRESS_RE = re.compile(r"^0x[a-fA-F0-9]{40}$")
_USDC_AMOUNT_RE = re.compile(r"^\d+(\.\d+)?$")


def _validate_evm_address(v: str) -> str:
    if not isinstance(v, str) or not _EVM_ADDRESS_RE.match(v):
        raise ValueError("must be a 0x-prefixed 40-char hex EVM address")
    return v


def _validate_usdc_amount(v: str) -> str:
    if not isinstance(v, str) or not _USDC_AMOUNT_RE.match(v):
        raise ValueError("must be a non-negative decimal string (e.g. '0.01')")
    return v


class _BaseFields(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool = True
    wallet: EvmAddress
    network: SupportedNetwork = "base"
    asset: EvmAddress | None = None
    facilitator_url: HttpUrl = Field(
        default=HttpUrl("https://facilitator.x402.org"),
        alias="facilitatorUrl",
    )
    description: str = Field(default="Payment required to call this Agent", max_length=200)

    @field_validator("wallet")
    @classmethod
    def _wallet_addr(cls, v: str) -> str:
        return _validate_evm_address(v)

    @field_validator("asset")
    @classmethod
    def _asset_addr(cls, v: str | None) -> str | None:
        return None if v is None else _validate_evm_address(v)


class FlatPaymentConfig(_BaseFields):
    """Per-call flat pricing. Caller pays `priceUsdc` per request."""

    mode: Literal["flat"]
    price_usdc: Annotated[str, Field(alias="priceUsdc")]

    @field_validator("price_usdc")
    @classmethod
    def _price_valid(cls, v: str) -> str:
        return _validate_usdc_amount(v)


class PerTokenPaymentConfig(_BaseFields):
    """Per-token pricing against a pre-funded credit balance. v1.1 runtime."""

    mode: Literal["per_token"]
    price_per_token_usdc: Annotated[str, Field(alias="pricePerTokenUsdc")]
    min_credit_balance_usdc: Annotated[str, Field(alias="minCreditBalanceUsdc")]

    @field_validator("price_per_token_usdc", "min_credit_balance_usdc")
    @classmethod
    def _amounts_valid(cls, v: str) -> str:
        return _validate_usdc_amount(v)


PaymentConfig = Annotated[
    Union[FlatPaymentConfig, PerTokenPaymentConfig],
    Field(discriminator="mode"),
]


def resolve_asset(config: FlatPaymentConfig | PerTokenPaymentConfig) -> str:
    """Asset address used in PaymentRequirements.asset — explicit `asset` wins."""
    if config.asset:
        return config.asset
    return USDC_ADDRESSES[config.network]


def parse_payment_config(data: dict) -> FlatPaymentConfig | PerTokenPaymentConfig:
    """Parse + validate a raw dict (from TOML / JSON) into a PaymentConfig.

    Accepts both snake_case and camelCase keys via field aliases — `priceUsdc` and
    `price_usdc` both work.
    """
    mode = data.get("mode")
    if mode == "flat":
        return FlatPaymentConfig.model_validate(data)
    if mode == "per_token":
        return PerTokenPaymentConfig.model_validate(data)
    raise ValueError(f"mode must be 'flat' or 'per_token', got {mode!r}")
