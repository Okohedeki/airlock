"""Fire-and-forget reporter — POST every call's outcome to the airlock
backend's /api/inspect endpoint. Failures are swallowed."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Protocol


class _HttpPostable(Protocol):
    async def post(self, url: str, json: dict, headers: dict) -> object: ...


@dataclass
class CallReporter:
    """Configures the reporter. Pass to `PaymentMiddleware(reporter=…)`."""

    url: str
    token: str
    project_name: str
    http: Optional[_HttpPostable] = None  # injectable for tests


@dataclass
class ReportableCall:
    caller: Optional[str]
    status: int
    request_url: str
    tokens_used: Optional[int]
    amount_usdc: Optional[str]
    payment_settled: bool


async def report(reporter: CallReporter, call: ReportableCall) -> None:
    """Fire-and-forget POST. Returns None and swallows all errors."""
    payload = {
        "project_name": reporter.project_name,
        "caller": call.caller,
        "status": call.status,
        "request_url": call.request_url,
        "tokens_used": call.tokens_used,
        "amount_usdc": call.amount_usdc,
        "payment_settled": call.payment_settled,
    }
    headers = {
        "content-type": "application/json",
        "authorization": f"Bearer {reporter.token}",
    }
    try:
        if reporter.http is not None:
            await reporter.http.post(
                f"{reporter.url.rstrip('/')}/api/inspect", json=payload, headers=headers
            )
            return
        # Lazy import so the module loads without httpx for pure-API consumers
        import httpx

        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(
                f"{reporter.url.rstrip('/')}/api/inspect", json=payload, headers=headers
            )
    except Exception:
        # Reporter is best-effort; never block a paid call on observability.
        pass
