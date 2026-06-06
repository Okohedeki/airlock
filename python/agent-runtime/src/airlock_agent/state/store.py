"""The State Store protocol + the tenant-scoped handle (frozen contract C3)."""

from __future__ import annotations

from typing import Any, Iterator, Protocol, runtime_checkable

RESERVED = "_system"


def _check_tenant(tenant: str) -> str:
    if not tenant or "/" in tenant:
        raise ValueError(f"tenant must be a non-empty segment without '/': {tenant!r}")
    return tenant


@runtime_checkable
class StateStore(Protocol):
    """Backends (memory, sqlite, redis, postgres) implement this one interface."""

    def get(self, key: str) -> Any | None: ...
    def set(self, key: str, value: Any, ttl_s: float | None = None) -> None: ...
    def delete(self, key: str) -> None: ...
    def list_prefix(self, prefix: str) -> Iterator[str]: ...
    def snapshot(self, key: str, value: Any) -> None: ...  # append-friendly set

    def scoped(self, tenant: str) -> "ScopedStore":
        return ScopedStore(self, _check_tenant(tenant))


class ScopedStore:
    """A tenant-pinned view. `rest` is everything after the tenant segment, e.g.
    "{session}/{run}/{kind}/{id}". Callers can't reach another tenant or `_system/`."""

    def __init__(self, backend: StateStore, tenant: str) -> None:
        self.tenant = _check_tenant(tenant)
        self._b = backend

    def _key(self, rest: str) -> str:
        return f"{self.tenant}/{rest}" if rest else f"{self.tenant}/"

    def get(self, rest: str) -> Any | None:
        return self._b.get(self._key(rest))

    def set(self, rest: str, value: Any, ttl_s: float | None = None) -> None:
        self._b.set(self._key(rest), value, ttl_s)

    def delete(self, rest: str) -> None:
        self._b.delete(self._key(rest))

    def list_prefix(self, rest: str = "") -> Iterator[str]:
        plen = len(self.tenant) + 1
        for k in self._b.list_prefix(self._key(rest)):
            yield k[plen:]  # strip "{tenant}/" so callers see tenant-relative keys

    def snapshot(self, rest: str, value: Any) -> None:
        self._b.snapshot(self._key(rest), value)
