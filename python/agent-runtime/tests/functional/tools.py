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
