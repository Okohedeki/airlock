"""Caller auth & multi-tenancy — epic 10 (ADR-0018), the router's stage-1 concern.

Authenticate each caller and resolve a Tenant id BEFORE the loop runs; reject
unauthenticated/invalid callers. Per-tenant isolation is then structural via
`store.scoped(tenant)` (frozen contract C3) — the runner already scopes all state,
sessions, and cache by tenant, so one tenant can never read another's keys.

v1 keys are operator-provided (airlock validates, does not issue). API keys map to a
tenant via a static map in `tenancy.keys` or the State Store under
`_system/apikeys/{sha256(key)}`. Unknown/missing key on an auth-required worker →
PermissionError (the surface maps it to 401).
"""

from __future__ import annotations

import hashlib
from typing import Any, Callable

from fastapi import Request


def _hash_key(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def _extract_key(request: Request) -> str | None:
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return request.headers.get("x-api-key")


def build_authenticator(
    auth_cfg: dict[str, Any], tenancy_cfg: dict[str, Any], store: Any
) -> Callable[[Request], str]:
    scheme = (auth_cfg.get("scheme") or "api_key").lower()
    static_keys = dict((tenancy_cfg.get("keys") or auth_cfg.get("keys") or {}))
    required = bool(auth_cfg.get("required", True))

    def authenticate(request: Request) -> str:
        if scheme in ("none", "open"):
            return request.headers.get("X-Airlock-Tenant", "default")
        key = _extract_key(request)
        if not key:
            if required:
                raise PermissionError("missing API key")
            return "default"
        if key in static_keys:
            return str(static_keys[key])
        if store is not None:
            mapped = store.get(f"_system/apikeys/{_hash_key(key)}")
            if mapped:
                return str(mapped)
        if required:
            raise PermissionError("invalid API key")
        return "default"

    return authenticate


def record_usage(store: Any, tenant: str, *, calls: int = 0, steps: int = 0, tokens: int = 0) -> None:
    """Attribute usage per tenant (epic 05 dashboard reads these). Tenant-prefixed
    so usage stays inside the tenant's isolation boundary."""
    if store is None:
        return
    scoped = store.scoped(tenant)
    cur = scoped.get("_usage/total") or {"calls": 0, "steps": 0, "tokens": 0}
    cur["calls"] += calls
    cur["steps"] += steps
    cur["tokens"] += tokens
    scoped.set("_usage/total", cur)
