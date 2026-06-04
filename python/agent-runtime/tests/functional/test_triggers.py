"""Functional tests for triggers (epic 11) — webhook signature, event mapping,
and cron with an injectable clock + missed-run policy."""

from __future__ import annotations

import hashlib
import hmac

from airlock_agent.state import MemoryStore
from airlock_agent.triggers import (
    CronSchedule,
    map_event_input,
    tick_cron,
    verify_hmac_sha256,
)


def _sign(secret: str, body: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def test_webhook_hmac_accepts_valid_rejects_bad():
    body = b'{"event":"push"}'
    assert verify_hmac_sha256("s3cr3t", body, _sign("s3cr3t", body))
    assert not verify_hmac_sha256("s3cr3t", body, _sign("wrong", body))


def test_event_payload_maps_to_run_input():
    payload = {"issue": {"title": "fix the bug"}}
    assert map_event_input(payload, {"input": "issue.title"}) == "fix the bug"
    # no mapping -> whole payload as JSON
    assert "issue" in map_event_input(payload, None)


def test_cron_fires_on_schedule_with_injected_clock():
    store = MemoryStore().scoped("default")
    sched = CronSchedule({"every_s": 60})
    fired = []
    # first tick at t=0 fires (no last_fire)
    assert tick_cron(sched, 0.0, store, "_system/cron/job", lambda: fired.append("a")) is True
    # 30s later — not due
    assert tick_cron(sched, 30.0, store, "_system/cron/job", lambda: fired.append("b")) is False
    # 65s — due again
    assert tick_cron(sched, 65.0, store, "_system/cron/job", lambda: fired.append("c")) is True
    assert fired == ["a", "c"]


def test_cron_catch_up_vs_skip_next_fire():
    skip = CronSchedule({"every_s": 60, "missed": "skip"})
    catch = CronSchedule({"every_s": 60, "missed": "catch_up"})
    # a long gap: last fired at 0, now is 500
    assert catch.next_fire(500.0, 0.0) == 60.0  # catch_up replays from the missed boundary
    assert skip.next_fire(500.0, 0.0) > 500.0  # skip realigns forward
