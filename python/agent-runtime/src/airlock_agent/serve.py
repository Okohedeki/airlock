"""`serve(adapter)` — the one line a template calls to go live."""

from __future__ import annotations

import os
from typing import Any

from .adapter import HarnessAdapter
from .surface import create_app


def config_from_env() -> Any:
    """PaymentConfig from env. Payment is OFF by default (free) — set
    PAYMENT_ENABLED=1 + PUBLISHER_WALLET to turn on flat per-call billing."""
    from airlock_payment import parse_payment_config

    return parse_payment_config(
        {
            "enabled": os.environ.get("PAYMENT_ENABLED") == "1",
            "wallet": os.environ.get(
                "PUBLISHER_WALLET", "0x0000000000000000000000000000000000000001"
            ),
            "network": os.environ.get("PAYMENT_NETWORK", "base-sepolia"),
            "mode": "flat",
            "priceUsdc": os.environ.get("PRICE_USDC", "0.001"),
        }
    )


def serve(
    adapter: HarnessAdapter,
    *,
    name: str = "airlock-agent",
    dist_dir: str = "dist",
    host: str = "0.0.0.0",
    port: int | None = None,
) -> None:
    import uvicorn

    app = create_app(adapter, name=name, payment_config=config_from_env(), dist_dir=dist_dir)
    uvicorn.run(app, host=host, port=port or int(os.environ.get("PORT", "3000")))
