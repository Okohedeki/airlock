"""Tools for the live-models demo."""

from __future__ import annotations


def echo(text: str = "", **kw):
    return text or kw
