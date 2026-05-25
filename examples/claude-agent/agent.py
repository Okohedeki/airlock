"""Claude Agent SDK options — the Harness config. Built lazily so the adapter's
mapping logic stays importable/testable without the SDK installed.

The model here is Claude via the Anthropic API (publisher-supplied key,
ANTHROPIC_API_KEY) — airlock never hosts inference (ADR-0008 still holds; the
"publisher-supplied endpoint" is Anthropic's API).

    pip install -r requirements.txt
    ANTHROPIC_API_KEY=sk-ant-... python app.py
"""

from __future__ import annotations

import os

MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-5")


def build_options(model: str | None = None):
    from claude_agent_sdk import ClaudeAgentOptions

    return ClaudeAgentOptions(model=model or MODEL)
