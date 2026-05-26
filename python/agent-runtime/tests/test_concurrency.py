"""Concurrency policy + BoundedGate behaviour."""

import asyncio

import pytest

from airlock_agent.concurrency import (
    BoundedGate,
    ConcurrencyPolicy,
    QueueFull,
    read_allow_unsafe_parallel,
    read_build_per_call,
    read_max_concurrency,
    read_max_queue,
    read_queue_timeout,
    resolve_policy,
)


# ---- env readers ----
def test_max_concurrency_default_and_floor():
    assert read_max_concurrency({}) == 4
    assert read_max_concurrency({"AIRLOCK_MAX_CONCURRENCY": "8"}) == 8
    assert read_max_concurrency({"AIRLOCK_MAX_CONCURRENCY": "0"}) == 1
    assert read_max_concurrency({"AIRLOCK_MAX_CONCURRENCY": "-3"}) == 1
    assert read_max_concurrency({"AIRLOCK_MAX_CONCURRENCY": "abc"}) == 4


def test_max_queue_and_timeout_defaults():
    assert read_max_queue({}) == 50
    assert read_max_queue({"AIRLOCK_MAX_QUEUE": "0"}) == 0
    assert read_queue_timeout({}) == 30.0
    assert read_queue_timeout({"AIRLOCK_QUEUE_TIMEOUT_S": "1.5"}) == 1.5


def test_build_per_call_default_follows_factory():
    assert read_build_per_call({}, is_factory=True) is True
    assert read_build_per_call({}, is_factory=False) is False
    assert read_build_per_call({"AIRLOCK_BUILD_PER_CALL": "0"}, is_factory=True) is False
    assert read_build_per_call({"AIRLOCK_BUILD_PER_CALL": "1"}, is_factory=False) is True


def test_allow_unsafe_parallel():
    assert read_allow_unsafe_parallel({"AIRLOCK_ALLOW_UNSAFE_PARALLEL": "1"}) is True
    assert read_allow_unsafe_parallel({}) is False


# ---- policy (instance fallback) ----
def test_policy_clamps_stateful_to_one():
    p = resolve_policy(reentrant=False, env={"AIRLOCK_MAX_CONCURRENCY": "8"})
    assert p.effective == 1


def test_policy_reentrant_honors_n():
    assert resolve_policy(reentrant=True, env={"AIRLOCK_MAX_CONCURRENCY": "8"}).effective == 8


def test_policy_unsafe_override_unclamps():
    p = resolve_policy(
        reentrant=False,
        env={"AIRLOCK_MAX_CONCURRENCY": "8", "AIRLOCK_ALLOW_UNSAFE_PARALLEL": "1"},
    )
    assert p.effective == 8


def test_policy_floor():
    assert ConcurrencyPolicy(requested=0, reentrant=True, allow_unsafe=False).effective == 1


# ---- BoundedGate ----
def test_gate_admits_up_to_n_then_queue_full():
    async def go():
        gate = BoundedGate(max_concurrency=2, max_queue=1, timeout=5)
        await gate.acquire()
        await gate.acquire()  # 2 running
        assert gate.pending == 2
        # one queue slot exists; acquiring it would block, so do it as a task
        waiter = asyncio.ensure_future(gate.acquire())
        await asyncio.sleep(0)  # let the waiter register (pending → 3)
        assert gate.pending == 3
        with pytest.raises(QueueFull):  # beyond N + max_queue
            await gate.acquire()
        gate.release()  # frees a slot → the waiter proceeds
        await waiter
        gate.release()
        gate.release()
        assert gate.pending == 0

    asyncio.run(go())


def test_gate_times_out_when_no_slot():
    async def go():
        gate = BoundedGate(max_concurrency=1, max_queue=10, timeout=0.05)
        await gate.acquire()  # the only slot
        with pytest.raises(asyncio.TimeoutError):
            await gate.acquire()
        assert gate.pending == 1  # the timed-out waiter decremented itself

    asyncio.run(go())
