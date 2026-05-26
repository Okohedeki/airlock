"""Importable fixtures for loader tests (factory / instance / custom callable)."""

_calls = {"n": 0}


def build_thing():
    """Factory: returns a fresh object each call (tracks how many times called)."""
    _calls["n"] += 1
    return {"id": _calls["n"]}


instance = {"id": "shared"}


def run(messages):
    return f"got {len(messages)}"
