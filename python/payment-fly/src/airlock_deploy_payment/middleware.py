"""x402 Payment Middleware for Starlette / FastAPI.

Mirrors the Node middlewares' flow:
  1. enabled=False  -> pass through
  2. mode=per_token -> 501 (interface ships v1; runtime in v1.1 per ADR-0005)
  3. no X-PAYMENT   -> 402 + PaymentRequired body
  4. malformed      -> 402 with error
  5. verify fails   -> 402 with reason
  6. happy path     -> call downstream, settle, attach X-PAYMENT-RESPONSE
  7. settle fails   -> 402 with reason (downstream response discarded)
"""

from __future__ import annotations

import base64
import json
from typing import Any

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from .config import FlatPaymentConfig, PerTokenPaymentConfig
from .envelope import build_payment_required
from .facilitator import Facilitator, HTTPFacilitator

PAYMENT_HEADER = "x-payment"
PAYMENT_RESPONSE_HEADER = "X-PAYMENT-RESPONSE"


def _decode_payment_header(header: str) -> dict:
    """Decode the base64-encoded JSON x402 payment payload header."""
    decoded = base64.b64decode(header).decode("utf-8")
    return json.loads(decoded)


def _encode_payment_response_header(settle_result: dict) -> str:
    return base64.b64encode(json.dumps(settle_result).encode("utf-8")).decode("ascii")


class PaymentMiddleware(BaseHTTPMiddleware):
    """Starlette / FastAPI middleware enforcing x402 payment per request.

    Wire it like any other Starlette middleware:

        from starlette.applications import Starlette
        from airlock_deploy_payment import PaymentMiddleware, parse_payment_config

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
    ) -> None:
        super().__init__(app)
        self.config = config
        self.facilitator: Facilitator = facilitator or HTTPFacilitator(str(config.facilitator_url))

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        if not self.config.enabled:
            return await call_next(request)

        if isinstance(self.config, PerTokenPaymentConfig):
            return JSONResponse(
                {"error": "per_token mode is not implemented in v1 (see ADR-0005)"},
                status_code=501,
            )

        required = build_payment_required(self.config, str(request.url))
        required_body = required.to_dict()
        requirements_dict = required_body["accepts"][0]

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

        settle_dict = {
            "success": settle.success,
            "transaction": settle.transaction,
            "network": settle.network,
            "payer": settle.payer,
        }
        response.headers[PAYMENT_RESPONSE_HEADER] = _encode_payment_response_header(settle_dict)
        return response
