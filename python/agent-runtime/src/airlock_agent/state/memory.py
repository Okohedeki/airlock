"""In-memory state store — the zero-dependency default for tests and ephemeral runs."""

from __future__ import annotations

import threading
import time
from typing import Any, Iterator

from .store import ScopedStore, StateStore, _check_tenant


class MemoryStore(StateStore):
    def __init__(self) -> None:
        self._d: dict[str, tuple[Any, float | None]] = {}
        self._lock = threading.RLock()

    def _live(self, key: str) -> bool:
        v = self._d.get(key)
        if v is None:
            return False
        _, exp = v
        if exp is not None and exp < time.time():
            self._d.pop(key, None)
            return False
        return True

    def get(self, key: str) -> Any | None:
        with self._lock:
            return self._d[key][0] if self._live(key) else None

    def set(self, key: str, value: Any, ttl_s: float | None = None) -> None:
        with self._lock:
            self._d[key] = (value, time.time() + ttl_s if ttl_s else None)

    def delete(self, key: str) -> None:
        with self._lock:
            self._d.pop(key, None)

    def list_prefix(self, prefix: str) -> Iterator[str]:
        with self._lock:
            keys = [k for k in self._d if k.startswith(prefix) and self._live(k)]
        return iter(sorted(keys))

    def snapshot(self, key: str, value: Any) -> None:
        self.set(key, value)

    def scoped(self, tenant: str) -> ScopedStore:
        return ScopedStore(self, _check_tenant(tenant))
