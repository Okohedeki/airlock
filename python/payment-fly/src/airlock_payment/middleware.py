"""x402 Payment Middleware for Starlette / FastAPI.

- Flat mode: every call requires X-PAYMENT; verify → handler → settle.
- Per-token mode: first call requires X-PAYMENT (topup) and gets
  X-Airlock-Session in the response. Subsequent calls send that session header
  to draw down the Caller's Credit Balance by `(X-Tokens-Used × pricePerToken)`.
  When the balance hits zero, the next call returns 402.
"""

from __future__ import annotations

import base64
import json
from typing import Any, Callable, Optional

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from .config import FlatPaymentConfig, PerTokenPaymentConfig
from .envelope import build_payment_required
from .facilitator import Facilitator, HTTPFacilitator
from .ledger import CreditLedger, InMemoryCreditLedger, InsufficientBalanceError
from .reporter import CallReporter, ReportableCall, report
from .types import SESSION_HEADER, TOKENS_USED_HEADER, USAGE_UNITS_HEADER

PAYMENT_HEADER = "x-payment"
PAYMENT_RESPONSE_HEADER = "X-PAYMENT-RESPONSE"

# How to read billable units from a response. Defaults to the header reader
# below; pass a custom callable to PaymentMiddleware for non-header schemes.
UsageExtractor = Callable[[Response], Optional[int]]


def default_usage_extractor(response: Response) -> Optional[int]:
    """Read billable units from the generic units header, then legacy tokens."""
    for name in (USAGE_UNITS_HEADER, TOKENS_USED_HEADER):
        raw = response.headers.get(name.lower()) or response.headers.get(name)
        if raw and raw.isdigit():
            n = int(raw)
            if n > 0:
                return n
    return None


def _decode_payment_header(header: str) -> dict:
    decoded = base64.b64decode(header).decode("utf-8")
    return json.loads(decoded)


def _encode_payment_response_header(settle_result: dict) -> str:
    return base64.b64encode(json.dumps(settle_result).encode("utf-8")).decode("ascii")


def _to_atomic(usdc: str) -> int:
    whole, _, frac = usdc.partition(".")
    return int(whole + (frac + "000000")[:6])


def _from_atomic(atomic: int) -> str:
    s = str(atomic).rjust(7, "0")
    whole, frac = s[:-6], s[-6:].rstrip("0")
    return whole if frac == "" else f"{whole}.{frac}"


def _multiply_usdc(price_usdc: str, count: int) -> str:
    return _from_atomic(_to_atomic(price_usdc) * count)


def _compare_usdc(a: str, b: str) -> int:
    aa, bb = _to_atomic(a), _to_atomic(b)
    return -1 if aa < bb else (1 if aa > bb else 0)


class PaymentMiddleware(BaseHTTPMiddleware):
    """Starlette / FastAPI middleware enforcing x402 payment per request.

    Wire it like any other Starlette middleware:

        from starlette.applications import Starlette
        from airlock_payment import PaymentMiddleware, parse_payment_config

        config = parse_payment_config({"mode": "flat", "wallet": "0x...", "priceUsdc": "0.001"})
        app = Starlette(routes=[...])
        app.add_middleware(PaymentMiddleware, config=config)
    """

    def __init__(
        self,
        app: Any,
        *,
        config: FlatPaymentConfig | PerTokenPaymentConfig,
        facilitator: Facilitator | None = None,
        ledger: CreditLedger | None = None,
        reporter: CallReporter | None = None,
        usage_extractor: UsageExtractor | None = None,
        exempt_paths: list[str] | None = None,
    ) -> None:
        super().__init__(app)
        self.config = config
        self.facilitator: Facilitator = facilitator or HTTPFacilitator(
            str(config.facilitator_url)
        )
        self.ledger: CreditLedger = ledger or InMemoryCreditLedger()
        self.reporter = reporter
        self.usage_extractor: UsageExtractor = usage_extractor or default_usage_extractor
        # Paths that are always free (health checks, discovery /.well-known, info).
        # An exempt entry matches the exact path or any sub-path under it.
        self.exempt_paths: list[str] = exempt_paths or []

    def _is_exempt(self, path: str) -> bool:
        for p in self.exempt_paths:
            if p == "/":
                if path == "/":
                    return True
            elif path == p or path.startswith(p.rstrip("/") + "/"):
                return True
        return False

    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        if not self.config.enabled or self._is_exempt(request.url.path):
            return await call_next(request)

        required = build_payment_required(self.config, str(request.url))
        required_body = required.to_dict()
        requirements_dict = required_body["accepts"][0]

        if isinstance(self.config, PerTokenPaymentConfig):
            response = await self._run_per_token(
                request, call_next, required_body, requirements_dict
            )
        else:
            response = await self._run_flat(
                request, call_next, required_body, requirements_dict
            )

        if self.reporter is not None:
            await self._fire_report(request, response)
        return response

    async def _fire_report(self, request: Request, response: Response) -> None:
        if self.reporter is None:
            return
        settled_header = response.headers.get(PAYMENT_RESPONSE_HEADER)
        tokens = self.usage_extractor(response)
        caller: str | None = None
        if settled_header:
            try:
                decoded = json.loads(base64.b64decode(settled_header).decode("utf-8"))
                caller = decoded.get("payer")
            except Exception:
                caller = None
        settled = settled_header is not None
        if settled:
            if isinstance(self.config, PerTokenPaymentConfig):
                amount_usdc: str | None = self.config.min_credit_balance_usdc
            else:
                amount_usdc = self.config.price_usdc
        else:
            amount_usdc = None
        await report(
            self.reporter,
            ReportableCall(
                caller=caller,
                status=response.status_code,
                request_url=str(request.url),
                tokens_used=tokens,
                amount_usdc=amount_usdc,
                payment_settled=settled,
            ),
        )

    async def _run_flat(
        self,
        request: Request,
        call_next: RequestResponseEndpoint,
        required_body: dict,
        requirements_dict: dict,
    ) -> Response:
        header = request.headers.get(PAYMENT_HEADER)
        if not header:
            return JSONResponse(required_body, status_code=402)
        try:
            payload = _decode_payment_header(header)
        except Exception:
            return JSONResponse(
                {**required_body, "error": "malformed X-PAYMENT header"}, status_code=402
            )

        verify = await self.facilitator.verify(payload, requirements_dict)
        if not verify.is_valid:
            return JSONResponse(
                {**required_body, "error": verify.invalid_reason or "payment verification failed"},
                status_code=402,
            )

        response = await call_next(request)

        settle = await self.facilitator.settle(payload, requirements_dict)
        if not settle.success:
            return JSONResponse(
                {**required_body, "error": settle.error_reason or "settlement failed"},
                status_code=402,
            )

        response.headers[PAYMENT_RESPONSE_HEADER] = _encode_payment_response_header(
            {
                "success": settle.success,
                "transaction": settle.transaction,
                "network": settle.network,
                "payer": settle.payer,
            }
        )
        return response

    async def _run_per_token(
        self,
        request: Request,
        call_next: RequestResponseEndpoint,
        required_body: dict,
        requirements_dict: dict,
    ) -> Response:
        assert isinstance(self.config, PerTokenPaymentConfig)
        session_header = request.headers.get(SESSION_HEADER.lower()) or request.headers.get(
            SESSION_HEADER
        )
        payment_header = request.headers.get(PAYMENT_HEADER)

        caller: str | None = None
        settle_dict: dict | None = None

        if session_header:
            caller = await self.ledger.verify_session(session_header)
            if not caller:
                return JSONResponse(
                    {**required_body, "error": "invalid or expired session"}, status_code=402
                )
        elif payment_header:
            try:
                payload = _decode_payment_header(payment_header)
            except Exception:
                return JSONResponse(
                    {**required_body, "error": "malformed X-PAYMENT header"}, status_code=402
                )
            verify = await self.facilitator.verify(payload, requirements_dict)
            if not verify.is_valid:
                return JSONResponse(
                    {
                        **required_body,
                        "error": verify.invalid_reason or "payment verification failed",
                    },
                    status_code=402,
                )
            settle = await self.facilitator.settle(payload, requirements_dict)
            if not settle.success:
                return JSONResponse(
                    {**required_body, "error": settle.error_reason or "settlement failed"},
                    status_code=402,
                )
            payer = settle.payer or verify.payer
            if not payer:
                return JSONResponse(
                    {**required_body, "error": "facilitator did not return payer"},
                    status_code=500,
                )
            caller = payer
            await self.ledger.credit(caller, self.config.min_credit_balance_usdc)
            settle_dict = {
                "success": settle.success,
                "transaction": settle.transaction,
                "network": settle.network,
                "payer": settle.payer,
            }
        else:
            return JSONResponse(required_body, status_code=402)

        # Per-call balance gate: any positive balance suffices.
        balance = await self.ledger.get_balance(caller)
        if _compare_usdc(balance, "0") <= 0:
            return JSONResponse(
                {**required_body, "error": "credit balance depleted; top up"}, status_code=402
            )

        response = await call_next(request)

        tokens = self.usage_extractor(response) or 0
        if tokens > 0:
            cost = _multiply_usdc(self.config.price_per_token_usdc, tokens)
            try:
                await self.ledger.debit(caller, cost)
            except InsufficientBalanceError:
                # Overdraft tolerated: drain remaining balance and return response.
                try:
                    await self.ledger.debit(caller, balance)
                except InsufficientBalanceError:
                    pass

        issued = session_header or await self.ledger.issue_session(caller)
        response.headers[SESSION_HEADER] = issued
        if settle_dict:
            response.headers[PAYMENT_RESPONSE_HEADER] = _encode_payment_response_header(settle_dict)
        return response
