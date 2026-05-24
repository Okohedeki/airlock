"""x402 v1 PaymentRequired envelope builder. Mirrors `payment-core/src/x402.ts`."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

from .config import FlatPaymentConfig, PerTokenPaymentConfig, resolve_asset

DEFAULT_TIMEOUT_SECONDS = 60


@dataclass
class PaymentRequirements:
    scheme: str
    network: str
    maxAmountRequired: str  # noqa: N815 — x402 spec uses camelCase on the wire
    resource: str
    description: str
    payTo: str  # noqa: N815
    maxTimeoutSeconds: int  # noqa: N815
    asset: str
    extra: dict | None = None


@dataclass
class PaymentRequired:
    accepts: list[PaymentRequirements]
    x402Version: int = 1  # noqa: N815
    error: str | None = None

    def to_dict(self) -> dict:
        out: dict = {"x402Version": self.x402Version, "accepts": [_clean(asdict(r)) for r in self.accepts]}
        if self.error is not None:
            out["error"] = self.error
        return out


def _clean(d: dict) -> dict:
    return {k: v for k, v in d.items() if v is not None}


def usdc_to_atomic(usdc: str) -> str:
    """Convert a USDC string ('0.01') to its atomic 6-decimal integer string ('10000')."""
    whole, _, frac = usdc.partition(".")
    frac_padded = (frac + "000000")[:6]
    combined = (whole + frac_padded).lstrip("0")
    return combined or "0"


def build_payment_required(
    config: FlatPaymentConfig | PerTokenPaymentConfig, resource: str
) -> PaymentRequired:
    """Build the HTTP 402 body the middleware returns to unpaid Callers.

    For `flat` mode the amount is the per-call price. For `per_token` mode it's
    the minimum credit-balance top-up (first 402 is a funding request, not a
    per-call charge).
    """
    if isinstance(config, FlatPaymentConfig):
        amount = config.price_usdc
        extra = None
        error = None
    else:
        amount = config.min_credit_balance_usdc
        extra = {"mode": "per_token_topup"}
        error = "credit balance below minimum; pay to top up"

    requirements = PaymentRequirements(
        scheme="exact",
        network=config.network,
        maxAmountRequired=usdc_to_atomic(amount),
        resource=resource,
        description=config.description,
        payTo=config.wallet,
        maxTimeoutSeconds=DEFAULT_TIMEOUT_SECONDS,
        asset=resolve_asset(config),
        extra=extra,
    )
    return PaymentRequired(accepts=[requirements], error=error)
