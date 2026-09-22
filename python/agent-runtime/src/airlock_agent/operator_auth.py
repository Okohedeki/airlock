"""Operator authorization is independent of caller/tenant authentication."""

from __future__ import annotations

import hmac
import os

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

OPERATOR_HEADER = "X-Airlock-Operator-Token"


def install_operator_auth(app: FastAPI, token: str | None = None) -> None:
    """Protect administration even when caller authentication is disabled.

    Capture configuration at startup. No token means administration is disabled;
    neither loopback requests nor forwarded headers grant implicit privileges.
    """
    expected = token if token is not None else os.environ.get("AIRLOCK_OPERATOR_TOKEN", "")

    @app.middleware("http")
    async def authorize_operator(request: Request, call_next):
        path = request.url.path.rstrip("/")
        protected = (
            path in ("/metrics", "/v1/manifest", "/v1/control", "/v1/runs/held")
            or path.startswith("/v1/control/")
            or (path.startswith("/v1/runs/") and path.endswith("/decision"))
        )
        if protected:
            if not expected:
                return JSONResponse(
                    {"error": "operator access is disabled; configure AIRLOCK_OPERATOR_TOKEN"},
                    status_code=503, headers={"Cache-Control": "no-store"},
                )
            supplied = request.headers.get(OPERATOR_HEADER, "")
            if not hmac.compare_digest(supplied.encode(), expected.encode()):
                return JSONResponse(
                    {"error": "operator credentials required"},
                    status_code=401, headers={"Cache-Control": "no-store"},
                )
        response = await call_next(request)
        if protected:
            response.headers["Cache-Control"] = "no-store"
        return response
