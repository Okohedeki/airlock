"""Concurrency policy + the bounded run-gate.

One deployed agent serves up to `max_concurrency` runs in parallel; callers
beyond that queue (FIFO) until a slot frees or the wait times out; callers
beyond the queue bound are shed immediately. Isolation between concurrent runs
comes from per-call rebuild (see loader/`__main__`); this module only governs
*how many* run at once and what happens to the overflow.

All knobs are env vars so the same mechanism works for self-host (`airlock up`
passes them) and a future hosted backend (injects them when provisioning).
"""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from typing import Mapping, Optional

DEFAULT_MAX_CONCURRENCY = 4
DEFAULT_MAX_QUEUE = 50
DEFAULT_QUEUE_TIMEOUT_S = 30.0

_Env = Optional[Mapping[str, str]]


def _env(env: _Env) -> Mapping[str, str]:
    return env if env is not None else os.environ


def _read_int(env: _Env, key: str, default: int, *, floor: int) -> int:
    raw = _env(env).get(key)
    if raw is None:
        return default
    try:
        return max(floor, int(raw))
    except ValueError:
        return default


def read_max_concurrency(env: _Env = None) -> int:
    """`AIRLOCK_MAX_CONCURRENCY` — max parallel runs (default 4, floor 1)."""
    return _read_int(env, "AIRLOCK_MAX_CONCURRENCY", DEFAULT_MAX_CONCURRENCY, floor=1)


def read_max_queue(env: _Env = None) -> int:
    """`AIRLOCK_MAX_QUEUE` — how many callers may wait beyond the running set
    before new arrivals are shed with 429 (default 50, floor 0)."""
    return _read_int(env, "AIRLOCK_MAX_QUEUE", DEFAULT_MAX_QUEUE, floor=0)


def read_queue_timeout(env: _Env = None) -> float:
    """`AIRLOCK_QUEUE_TIMEOUT_S` — max seconds a caller waits in the queue
    before being shed with 429 (default 30, floor 0 = no wait)."""
    raw = _env(env).get("AIRLOCK_QUEUE_TIMEOUT_S")
    if raw is None:
        return DEFAULT_QUEUE_TIMEOUT_S
    try:
        return max(0.0, float(raw))
    except ValueError:
        return DEFAULT_QUEUE_TIMEOUT_S


def read_build_per_call(env: _Env = None, *, is_factory: bool = False) -> bool:
    """`AIRLOCK_BUILD_PER_CALL` — rebuild a fresh agent wrapper per request for
    isolation. Defaults on for factory entrypoints (cheap when the model is
    out-of-process), off for bare instances (nothing to re-call)."""
    raw = _env(env).get("AIRLOCK_BUILD_PER_CALL")
    if raw is None:
        return is_factory
    return raw == "1"


def read_allow_unsafe_parallel(env: _Env = None) -> bool:
    """`AIRLOCK_ALLOW_UNSAFE_PARALLEL` — let a stateful *instance* entrypoint run
    in parallel anyway (state may mix; only correct when the publisher knows the
    object is reentrant). No effect when build_per_call is on."""
    return _env(env).get("AIRLOCK_ALLOW_UNSAFE_PARALLEL") == "1"


@dataclass(frozen=True)
class ConcurrencyPolicy:
    """Effective parallelism for a *shared* (non-per-call) agent object.

    Per-call rebuild makes every harness safe to run in parallel, so this only
    governs the instance-entrypoint fallback: a stateful object clamps to 1
    unless the publisher declares it reentrant or opts into unsafe parallel.
    """

    requested: int
    reentrant: bool
    allow_unsafe: bool

    @property
    def effective(self) -> int:
        if self.reentrant or self.allow_unsafe:
            return max(1, self.requested)
        return 1


def resolve_policy(*, reentrant: bool, env: _Env = None) -> ConcurrencyPolicy:
    return ConcurrencyPolicy(
        requested=read_max_concurrency(env),
        reentrant=reentrant,
        allow_unsafe=read_allow_unsafe_parallel(env),
    )


class QueueFull(Exception):
    """Raised when a request arrives and the run queue is already at capacity."""


class BoundedGate:
    """Async run-gate: up to `max_concurrency` concurrent holders, up to
    `max_queue` more waiting (FIFO), arrivals beyond that raise `QueueFull`, and
    a wait longer than `timeout` raises `asyncio.TimeoutError`.

    Single event loop only — `_pending` is a plain int because all mutation
    happens on the loop thread (the work itself runs in a threadpool, but
    acquire/release run inline on the loop).
    """

    def __init__(self, max_concurrency: int, max_queue: int, timeout: float) -> None:
        self.max_concurrency = max(1, max_concurrency)
        self.max_queue = max(0, max_queue)
        self.timeout = max(0.0, timeout)
        self._sem = asyncio.Semaphore(self.max_concurrency)
        self._pending = 0  # running + waiting

    @property
    def pending(self) -> int:
        return self._pending

    async def acquire(self) -> None:
        if self._pending >= self.max_concurrency + self.max_queue:
            raise QueueFull
        self._pending += 1
        try:
            if self.timeout > 0:
                await asyncio.wait_for(self._sem.acquire(), timeout=self.timeout)
            else:
                # timeout 0 → only grab a slot if one is free right now
                if self._sem.locked():
                    raise asyncio.TimeoutError
                await self._sem.acquire()
        except (asyncio.TimeoutError, asyncio.CancelledError):
            self._pending -= 1
            raise

    def release(self) -> None:
        self._sem.release()
        self._pending -= 1

    async def __aenter__(self) -> "BoundedGate":
        await self.acquire()
        return self

    async def __aexit__(self, *exc: object) -> None:
        self.release()
