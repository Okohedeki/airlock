"""Tools for the live demo (resolved by worker.yaml as `tools:<name>`)."""

from __future__ import annotations

import time


def echo(text: str = "", **kw):
    return text or kw


def add(a: int = 0, b: int = 0, **kw):
    return {"sum": a + b}


def send(to: str = "", body: str = "", **kw):
    # A "side-effecting" tool — the one we gate behind human approval.
    return {"sent_to": to, "body": body}


def slow(seconds: float = 30.0, **kw):
    time.sleep(seconds)  # trips the sandbox wall-clock limit
    return "finished"
