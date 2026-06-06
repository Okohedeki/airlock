"""SQLite state store — the single-box, zero-extra-dependency default (ADR-0016).

JSON-serialized values in one key/value table with optional TTL. Good enough for
self-host; Redis/Postgres adapters implement the same protocol for scale.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from typing import Any, Iterator

from .store import ScopedStore, StateStore, _check_tenant


class SQLiteStore(StateStore):
    def __init__(self, path: str = ".airlock/state.db") -> None:
        if path != ":memory:":
            os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.execute(
            "CREATE TABLE IF NOT EXISTS kv ("
            " key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at REAL)"
        )
        self._conn.commit()
        self._lock = threading.RLock()

    def get(self, key: str) -> Any | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT value, expires_at FROM kv WHERE key=?", (key,)
            ).fetchone()
            if row is None:
                return None
            value, exp = row
            if exp is not None and exp < time.time():
                self._conn.execute("DELETE FROM kv WHERE key=?", (key,))
                self._conn.commit()
                return None
            return json.loads(value)

    def set(self, key: str, value: Any, ttl_s: float | None = None) -> None:
        exp = time.time() + ttl_s if ttl_s else None
        with self._lock:
            self._conn.execute(
                "INSERT INTO kv(key, value, expires_at) VALUES(?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at",
                (key, json.dumps(value), exp),
            )
            self._conn.commit()

    def delete(self, key: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM kv WHERE key=?", (key,))
            self._conn.commit()

    def list_prefix(self, prefix: str) -> Iterator[str]:
        now = time.time()
        with self._lock:
            rows = self._conn.execute(
                r"SELECT key, expires_at FROM kv WHERE key LIKE ? ESCAPE '\' ORDER BY key",
                (prefix.replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_") + "%",),
            ).fetchall()
        return iter([k for k, exp in rows if exp is None or exp >= now])

    def snapshot(self, key: str, value: Any) -> None:
        self.set(key, value)

    def scoped(self, tenant: str) -> ScopedStore:
        return ScopedStore(self, _check_tenant(tenant))
