"""Module-level tools for functional tests (resolvable as `tests.functional.tools:name`)."""

from __future__ import annotations

import time


def echo(text: str = "", **kw):
    return text or kw


def add(a: int = 0, b: int = 0, **kw):
    return {"sum": a + b}


def slow(seconds: float = 30.0, **kw):
    time.sleep(seconds)  # used to trip the sandbox wall-clock limit
    return "finished"


def boom(**kw):
    raise RuntimeError("tool failed on purpose")


# A side-effecting tool with a call counter — used to prove resume/fork don't re-run
# already-executed tools.
_CALLS = {"bump": 0}


def bump(**kw):
    _CALLS["bump"] += 1
    return {"calls": _CALLS["bump"]}


def bump_count() -> int:
    return _CALLS["bump"]


def reset_bump() -> None:
    _CALLS["bump"] = 0
