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
import math
import os
import time
from collections import deque
from dataclasses import dataclass
from typing import Mapping, Optional

DEFAULT_MAX_CONCURRENCY = 4
DEFAULT_MAX_QUEUE = 50
DEFAULT_QUEUE_TIMEOUT_S = 30.0
# Generous default wait budget — the old blind 30s shed callers who'd happily
# wait. Latency-awareness comes from comparing this budget against the *live*
# estimated wait (run-time EWMA × queue depth), not a fixed per-caller countdown.
DEFAULT_MAX_WAIT_S = 120.0
# When the budget is auto-derived, allow ~this many run-times of queueing.
_WAIT_BUDGET_EWMA_MULT = 5.0
_EWMA_ALPHA = 0.3

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
    """`AIRLOCK_MAX_CONCURRENCY` — how many runs the *model* can serve in parallel
    (default 4, floor 1). This is the model's real capacity, not a wrapper limit:
    set it to e.g. `llama-server --parallel N` or a remote provider's concurrency.
    Setting it above what the model can actually batch over-subscribes the model
    and makes every in-flight run slower, not faster."""
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


def read_max_wait(env: _Env = None) -> float:
    """`AIRLOCK_MAX_WAIT_S` — the wait budget: the most seconds a caller should be
    expected to queue before we shed it with `429` + `Retry-After`. Falls back to
    the deprecated `AIRLOCK_QUEUE_TIMEOUT_S`, then `DEFAULT_MAX_WAIT_S`. Unlike the
    old blind timeout this is a *budget* compared against the live estimated wait,
    so callers who'd wait a reasonable time queue instead of being dropped."""
    e = _env(env)
    raw = e.get("AIRLOCK_MAX_WAIT_S")
    if raw is None:
        raw = e.get("AIRLOCK_QUEUE_TIMEOUT_S")  # deprecated alias
    if raw is None:
        return DEFAULT_MAX_WAIT_S
    try:
        return max(0.0, float(raw))
    except ValueError:
        return DEFAULT_MAX_WAIT_S


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
    """Raised when a request can't be admitted — the queue is structurally full,
    or the estimated wait exceeds the caller's budget. `retry_after` is the
    estimated seconds until a slot frees (0 when there's no estimate yet)."""

    def __init__(self, retry_after: float = 0.0) -> None:
        super().__init__("run queue at capacity")
        self.retry_after = max(0.0, retry_after)


class BoundedGate:
    """Async run-gate with latency-aware admission.

    Up to `max_concurrency` runs execute at once; the rest queue (FIFO) up to
    `max_queue`. Two things shed a caller with `QueueFull` (→ 429):
      • structural — arrivals beyond `max_concurrency + max_queue`;
      • latency — when the *estimated* wait (live run-time EWMA × queue depth)
        exceeds `max_wait`, refuse up front with `Retry-After` rather than make
        the caller block, then 429, on a blind countdown.
    `timeout` is the hard ceiling on how long an admitted caller blocks; a wait
    past it raises `asyncio.TimeoutError`. `max_wait=None` disables the latency
    gate (used by unit tests and when unconfigured), leaving the original
    structural-only behaviour.

    Single event loop only — `_pending`/`_running` are plain ints because all
    mutation happens on the loop thread (the work runs in a threadpool, but
    acquire/release run inline on the loop).
    """

    def __init__(
        self,
        max_concurrency: int,
        max_queue: int,
        timeout: float,
        *,
        max_wait: Optional[float] = None,
    ) -> None:
        self.max_concurrency = max(1, max_concurrency)
        self.max_queue = max(0, max_queue)
        self.timeout = max(0.0, timeout)
        self.max_wait = None if max_wait is None else max(0.0, max_wait)
        self._sem = asyncio.Semaphore(self.max_concurrency)
        self._pending = 0  # running + waiting
        self._ewma_run_s = 0.0
        self._starts: "deque[float]" = deque()

    @property
    def pending(self) -> int:
        return self._pending

    def _estimate_wait(self, *, extra: int = 0) -> float:
        """Seconds until a slot is likely free for a caller `extra` places back.

        Derived from `_pending` only — the count we mutate *synchronously* before
        the await. (A separate `_running` counter lags: a holder isn't marked
        running until after it awaits the semaphore, so a concurrently-arriving
        caller would read it stale and the admission gate would misfire.)"""
        in_system = self._pending + extra
        if in_system <= self.max_concurrency:
            return 0.0
        ahead = in_system - self.max_concurrency
        return self._ewma_run_s * math.ceil(ahead / self.max_concurrency)

    def _record_run(self, duration: float) -> None:
        if duration <= 0:
            return
        if self._ewma_run_s <= 0:
            self._ewma_run_s = duration
        else:
            self._ewma_run_s = _EWMA_ALPHA * duration + (1 - _EWMA_ALPHA) * self._ewma_run_s

    async def acquire(self) -> None:
        # Structural bound — the queue itself is full.
        if self._pending >= self.max_concurrency + self.max_queue:
            raise QueueFull(self._estimate_wait(extra=1))
        # Latency-aware admission — refuse callers who'd wait past the budget,
        # but only once we have a run-time estimate to judge by. `_estimate_wait`
        # returns 0 while a slot is free, so this never sheds an admittable caller.
        if self.max_wait is not None and self._ewma_run_s > 0:
            est = self._estimate_wait(extra=1)
            if est > self.max_wait > 0:
                raise QueueFull(est)
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
        self._starts.append(time.monotonic())

    def release(self) -> None:
        self._sem.release()
        self._pending -= 1
        if self._starts:
            self._record_run(time.monotonic() - self._starts.popleft())

    def stats(self) -> dict:
        """A snapshot for the info/metrics endpoints — answers 'are we at capacity?'
        `running`/`waiting` are derived from `_pending` (see `_estimate_wait`)."""
        running = min(self._pending, self.max_concurrency)
        return {
            "running": running,
            "waiting": self._pending - running,
            "pending": self._pending,
            "max_concurrency": self.max_concurrency,
            "max_queue": self.max_queue,
            "ewma_run_s": round(self._ewma_run_s, 3),
            "est_wait_s": round(self._estimate_wait(extra=1), 3),
        }

    async def __aenter__(self) -> "BoundedGate":
        await self.acquire()
        return self

    async def __aexit__(self, *exc: object) -> None:
        self.release()
