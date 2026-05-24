"""Shared type aliases and constants for airlock-payment.

Mirrors the TypeScript `@airlockhq/payment-core` types so a Publisher's
config translates 1:1 across the Node and Python middlewares.
"""

from __future__ import annotations

from typing import Literal

PaymentMode = Literal["flat", "per_token"]
"""Pricing model. `flat` ships in v1; `per_token` is interface-only (v1.1)."""

CallerId = str
"""EVM address (lowercase hex with 0x prefix) recovered from the x402 signature."""

TOKENS_USED_HEADER = "X-Tokens-Used"
"""Response header an Agent sets to report token usage; consumed by per_token mode."""

SESSION_HEADER = "X-Airlock-Session"
"""Header carrying the opaque per-Caller session token issued after x402 topup."""
