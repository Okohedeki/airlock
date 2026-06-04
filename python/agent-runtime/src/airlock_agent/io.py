"""Contract shaping — epic 13. Guard inputs before the loop spends tokens; enforce
schema/format/redaction on outputs. The redactor is shared with epic 05 (trace
persistence imports `redact`).

Harness-agnostic: this sits at the surface boundary, not inside the loop, so it
applies on ALL harnesses (frozen contract C1).
"""

from __future__ import annotations

import re
from typing import Any

# Built-in prompt-injection denylist starter set; operators EXTEND (not replace) it
# via io.input_guards[].patterns in worker.yaml.
INJECTION_PATTERNS = [
    r"(?i)ignore\b.{0,40}(instructions|prompts?)",
    r"(?i)disregard\b.{0,40}(instructions|prompts?|system)",
    r"(?i)you are now (a|an|in)\b.{0,20}(developer|jailbreak|DAN)",
    r"(?i)reveal\b.{0,30}(system prompt|instructions)",
]

# Default redaction classes (deterministic, model-free). Reuse of airlock-config
# permissions `data_classes` is a future consolidation.
REDACTION_RULES = {
    "email": r"[\w.+-]+@[\w-]+\.[\w.-]+",
    "ssn": r"\b\d{3}-\d{2}-\d{4}\b",
    "credit_card": r"\b(?:\d[ -]*?){13,16}\b",
    "api_key": r"\b(?:sk|pk|api)[-_][A-Za-z0-9]{16,}\b",
}


class InputRejected(ValueError):
    def __init__(self, reason: str, status: int = 400) -> None:
        super().__init__(reason)
        self.reason = reason
        self.status = status


def redact(text: Any, classes: list[str] | None = None, rules: dict[str, str] | None = None) -> Any:
    """Mask sensitive substrings. Shared with epic-05 trace persistence."""
    if not isinstance(text, str):
        return text
    active = rules or REDACTION_RULES
    use = classes if classes is not None else list(active.keys())
    out = text
    for cls in use:
        pat = active.get(cls)
        if pat:
            out = re.sub(pat, f"[REDACTED:{cls}]", out)
    return out


def guard_input(messages: list[dict[str, Any]], guards: list[dict[str, Any]] | None) -> None:
    """Reject invalid / injection-marked input BEFORE any model call. Raises
    InputRejected (mapped to an HTTP status by the surface)."""
    patterns = list(INJECTION_PATTERNS)
    max_len = 0
    for g in guards or []:
        patterns += list(g.get("patterns") or [])
        max_len = max(max_len, int(g.get("max_chars") or 0))
    text = "\n".join(str(m.get("content", "")) for m in messages)
    if max_len and len(text) > max_len:
        raise InputRejected(f"input exceeds max_chars={max_len}", status=413)
    for pat in patterns:
        if re.search(pat, text):
            raise InputRejected("input rejected: prompt-injection pattern matched", status=422)


def enforce_output(content: str, io_cfg: dict[str, Any]) -> tuple[str, bool]:
    """Enforce the output contract. Returns (content, ok). For v1: optional JSON
    format check + redaction. If JSON is required and the content isn't valid JSON,
    the caller may repair once (epic 02 budget) then this rejects-after-redacting."""
    out_cfg = (io_cfg or {}).get("output") or {}
    redact_classes = out_cfg.get("redact")
    if redact_classes:
        content = redact(content, classes=list(redact_classes))
    fmt = out_cfg.get("format")
    if fmt == "json":
        import json

        try:
            json.loads(content)
        except (json.JSONDecodeError, TypeError):
            return content, False
    return content, True
