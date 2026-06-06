"""Pluggable State Store — frozen contract C3 (epic 04, ADR-0016).

Tenant-first hierarchical keys make isolation structural:
`{tenant}/{session}/{run}/{kind}/{id}` — tenant is always segment 1, so
`list_prefix("{tenant}/")` can never cross tenants. Consumers receive a
`scoped(tenant)` handle and never build raw keys. Cross-tenant registries
(versions, workers) live under the reserved `_system/` prefix.
"""

from __future__ import annotations

from .store import ScopedStore, StateStore
from .memory import MemoryStore
from .sqlite import SQLiteStore

__all__ = ["StateStore", "ScopedStore", "MemoryStore", "SQLiteStore", "open_store"]


def open_store(backend: str = "sqlite", dsn: str | None = None) -> StateStore:
    """Open a state store by backend name (worker.yaml `state.backend`)."""
    backend = (backend or "sqlite").lower()
    if backend in ("memory", "mem"):
        return MemoryStore()
    if backend in ("sqlite", "files", "file"):
        return SQLiteStore(dsn or ".airlock/state.db")
    raise ValueError(f"unknown state backend '{backend}' (have: memory, sqlite)")
