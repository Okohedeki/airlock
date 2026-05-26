"""`serve(adapter)` — the one line a template calls to go live."""

from __future__ import annotations

import os
from typing import Any

from .adapter import HarnessAdapter
from .concurrency import read_max_queue, read_queue_timeout, resolve_policy
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
    reentrant: bool = False,
) -> None:
    import uvicorn

    # serve() takes an already-built adapter (one shared object), so concurrency
    # follows the instance-entrypoint policy: clamp to 1 unless the adapter is
    # declared reentrant (or AIRLOCK_ALLOW_UNSAFE_PARALLEL=1).
    app = create_app(
        adapter,
        name=name,
        payment_config=config_from_env(),
        dist_dir=dist_dir,
        max_concurrency=resolve_policy(reentrant=reentrant).effective,
        max_queue=read_max_queue(),
        queue_timeout_s=read_queue_timeout(),
    )
    uvicorn.run(app, host=host, port=port or int(os.environ.get("PORT", "3000")))
