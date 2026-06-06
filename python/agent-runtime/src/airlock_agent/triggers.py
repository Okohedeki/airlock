"""Triggers — epic 11. Fire a Worker run from cron, webhook, or event.

A triggered run is "just another request source": each trigger constructs a run
input and hands it to the run function, which flows through the engine (and, in a
fleet, enters the router pipeline at stage 2 — frozen contract C4). Cron uses an
injectable clock so schedules are testable without wall-clock waits; missed runs
across restarts are governed by a per-trigger skip|catch_up policy backed by the
State Store (frozen contract C3).
"""

from __future__ import annotations

import hashlib
import hmac
from typing import Any, Callable


# ---- webhook signature verification ----------------------------------------
def verify_hmac_sha256(secret: str, body: bytes, signature: str) -> bool:
    """Constant-time HMAC-SHA256 check. `signature` may be hex, optionally with a
    `sha256=` prefix (GitHub-style)."""
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    got = signature.split("=", 1)[1] if "=" in signature else signature
    return hmac.compare_digest(expected, got)


# ---- event payload -> run input mapping -------------------------------------
def map_event_input(payload: dict[str, Any], mapping: dict[str, str] | None) -> str:
    """Map an event payload to a run input via a declarative dotted-path mapping.
    `mapping = {"input": "issue.title"}` pulls payload["issue"]["title"]. With no
    mapping, the whole payload is JSON-encoded."""
    import json

    if not mapping or "input" not in mapping:
        return json.dumps(payload)
    cur: Any = payload
    for part in str(mapping["input"]).split("."):
        if isinstance(cur, dict):
            cur = cur.get(part)
    return cur if isinstance(cur, str) else json.dumps(cur)


# ---- cron scheduling --------------------------------------------------------
class CronSchedule:
    """A minimal schedule: `{"every_s": N}` (interval). `due(now, last_fire)` returns
    whether a fire is due. With a `catch_up` policy a long gap still fires once;
    `skip` (default) just realigns to the next interval."""

    def __init__(self, spec: dict[str, Any]) -> None:
        self.every_s = float(spec.get("every_s") or 0)
        self.policy = spec.get("missed", "skip")  # skip | catch_up

    def due(self, now: float, last_fire: float | None) -> bool:
        if self.every_s <= 0:
            return False
        if last_fire is None:
            return True
        return (now - last_fire) >= self.every_s

    def next_fire(self, now: float, last_fire: float | None) -> float:
        if last_fire is None:
            return now
        if self.policy == "catch_up":
            return last_fire + self.every_s
        # skip: realign to the next boundary at or after now
        missed = max(0, int((now - last_fire) // self.every_s))
        return last_fire + (missed + 1) * self.every_s


def tick_cron(
    schedule: CronSchedule, now: float, scoped_store: Any, key: str,
    fire: Callable[[], Any],
) -> bool:
    """Fire the cron job if due, recording last_fire in the State Store (C3).
    Returns True if it fired. `now` is injected so this is testable."""
    last = scoped_store.get(key)
    last_fire = last.get("at") if isinstance(last, dict) else None
    if not schedule.due(now, last_fire):
        return False
    fire()
    scoped_store.set(key, {"at": now})
    return True
