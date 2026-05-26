"""Let a deployed agent BUY from other agents over x402 (agent-to-agent commerce).

Optional — install the extra and provide a self-custody wallet key:

    pip install 'airlock-agent[crypto]'
    AIRLOCK_WALLET_KEY=0x...            # the agent's wallet (base-sepolia by default)
    AIRLOCK_SPEND_PER_CALL=0.05         # spend cap so an autonomous loop can't drain it
    AIRLOCK_SPEND_PER_PERIOD=1.00       # optional rolling-window budget

`buy()` is a sync wrapper safe to call from inside an adapter's `run()` (which the
surface offloads to a worker thread, so there's no running event loop). It returns the
purchased agent's response text. `build_smolagents_buy_tool()` exposes it to a smolagents
model as a tool it can choose to call. airlock-crypto holds the key, not airlock.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any


def crypto_available() -> bool:
    try:
        import airlock_crypto  # noqa: F401

        return True
    except ImportError:
        return False


def _wallet_and_cap() -> tuple[Any, Any]:
    from airlock_crypto import SpendCap, Wallet

    network = os.environ.get("AIRLOCK_WALLET_NETWORK", "base-sepolia")
    wallet = Wallet.load(network)
    cap = SpendCap(
        per_call_usdc=os.environ.get("AIRLOCK_SPEND_PER_CALL", "0.10"),
        per_period_usdc=os.environ.get("AIRLOCK_SPEND_PER_PERIOD"),
    )
    return wallet, cap


def buy(url: str, *, max_price: str = "0.01", method: str = "GET", json: Any | None = None) -> str:
    """Pay an x402-paywalled agent and return its response text.

    Raises if airlock-crypto isn't installed or no wallet key is configured.
    """
    from airlock_crypto import pay

    wallet, cap = _wallet_and_cap()
    result = asyncio.run(
        pay(url, wallet=wallet, method=method, json=json, max_price=max_price, cap=cap)
    )
    return result.response.text


def build_smolagents_buy_tool() -> Any:
    """A smolagents Tool the model can call to buy a service from another agent."""
    from smolagents import tool

    @tool
    def buy_from_agent(url: str, max_price: str = "0.01") -> str:
        """Pay another agent's paid (x402) endpoint and return its answer.

        Args:
            url: the other agent's paywalled URL (e.g. .../v1/chat/completions).
            max_price: the most USDC to spend on this single call.
        """
        return buy(url, max_price=max_price, method="POST")

    return buy_from_agent
