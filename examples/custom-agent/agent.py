"""Custom harness — a plain `run(messages) -> str` callable (TERMINAL).

airlock can only observe the final result: no tool extraction, no mid-run control. This
example exists to show the OWN-vs-Terminal contrast (see CONTEXT.md). To get the full
control set on `custom`, implement the Planner protocol or expose extractable tools.
"""

from __future__ import annotations

import re


def run(messages):
    """Your own agent code. Here, a trivial calculator — no framework, no adapter."""
    last = messages[-1].get("content", "") if messages else ""
    m = re.search(r"(\d+)\D+(\d+)", last)
    return str(int(m.group(1)) * int(m.group(2))) if m else "no numbers found"
