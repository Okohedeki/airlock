"""HTTP client for the x402 Facilitator (Coinbase's public one by default).

The Facilitator exposes two POST endpoints:
  POST {url}/verify  — { x402Version, paymentPayload, paymentRequirements } -> VerifyResponse
  POST {url}/settle  — same body -> SettleResponse

Per the x402 spec at https://www.x402.org. We talk directly to it via httpx —
no SDK dependency, which keeps the package light and version-stable.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, Any

import httpx


@dataclass
class VerifyResponse:
    is_valid: bool
    invalid_reason: str | None = None
    payer: str | None = None


@dataclass
class SettleResponse:
    success: bool
    error_reason: str | None = None
    transaction: str | None = None
    network: str | None = None
    payer: str | None = None


class Facilitator(Protocol):
    """Narrow surface used by the middleware — easy to stub in tests."""

    async def verify(self, payload: dict, requirements: dict) -> VerifyResponse: ...
    async def settle(self, payload: dict, requirements: dict) -> SettleResponse: ...


class HTTPFacilitator:
    """Default Facilitator that POSTs to a remote verify/settle endpoint."""

    def __init__(self, url: str, *, timeout_seconds: float = 30.0) -> None:
        self.url = url.rstrip("/")
        self._timeout = timeout_seconds

    async def _post(self, path: str, body: dict) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.post(f"{self.url}/{path}", json=body)
            resp.raise_for_status()
            return resp.json()

    async def verify(self, payload: dict, requirements: dict) -> VerifyResponse:
        data = await self._post(
            "verify",
            {"x402Version": 1, "paymentPayload": payload, "paymentRequirements": requirements},
        )
        return VerifyResponse(
            is_valid=bool(data.get("isValid")),
            invalid_reason=data.get("invalidReason"),
            payer=data.get("payer"),
        )

    async def settle(self, payload: dict, requirements: dict) -> SettleResponse:
        data = await self._post(
            "settle",
            {"x402Version": 1, "paymentPayload": payload, "paymentRequirements": requirements},
        )
        return SettleResponse(
            success=bool(data.get("success")),
            error_reason=data.get("errorReason"),
            transaction=data.get("transaction"),
            network=data.get("network"),
            payer=data.get("payer"),
        )
