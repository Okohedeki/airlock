"""Loop control & guards — epic 02, riding on the engine's ControlSource seam.

A `PolicyControlSource` is built from the `controls` block of worker.yaml and is
consumed by the loop: `gate()` runs at the tool-dispatch boundary (WRAP-ok), and
`evaluate()` runs between steps (budget/$ stop is OWN-only — it needs per-step
model token counts, frozen contract C1).

Held-run approval (epic 02 mid-run intervention): a tool flagged `require_approval`
parks the run under `{tenant}/_held/{run}` and the engine returns BLOCKED. An
Operator records a decision via the surface approval route; on the next call the
gate finds the decision and applies it (approve / deny / edit-args / override /
skip). No decision within the window → auto-deny.

The `when` matcher is a small, **safe, no-eval** structured matcher (not Python
eval): per-arg conditions {eq|ne|contains|regex|in|gt|lt}. Reusing airlock-config's
`when` evaluator is a future consolidation.
"""

from __future__ import annotations

import re
import json
import time
import uuid
from typing import Any

from .events import ControlSignal, ControlSource, StepEvent
from .planner import ToolCall


def match_when(when: dict[str, Any], args: dict[str, Any]) -> bool:
    """True if every arg condition in `when` holds. Empty `when` => matches all."""
    for arg, cond in (when or {}).items():
        val = args.get(arg)
        if not isinstance(cond, dict):  # bare value => equality
            if val != cond:
                return False
            continue
        for op, target in cond.items():
            if op == "eq" and val != target:
                return False
            if op == "ne" and val == target:
                return False
            if op == "contains" and (val is None or str(target) not in str(val)):
                return False
            if op == "regex" and (val is None or not re.search(str(target), str(val))):
                return False
            if op == "in" and val not in target:
                return False
            if op == "gt" and not (isinstance(val, (int, float)) and val > target):
                return False
            if op == "lt" and not (isinstance(val, (int, float)) and val < target):
                return False
    return True


class PolicyControlSource(ControlSource):
    def __init__(
        self,
        controls: dict[str, Any],
        *,
        run_id: str = "run",
        store: Any = None,  # ScopedStore (tenant-scoped) for held-run parking
        price_per_1k: float = 0.0,  # USD per 1k tokens (from pricing block, epic 05)
        approval_window_s: float = 0.0,  # 0 = no auto-deny
    ) -> None:
        self.max_steps = int(controls.get("max_steps") or 0)
        budget = controls.get("budget") or {}
        self.budget_tokens = int(budget.get("tokens") or 0)
        self.budget_usd = float(budget.get("usd") or 0)
        self.tool_gates = list(controls.get("tool_gates") or [])
        self.approvals = list(controls.get("approvals") or [])
        self.run_id = run_id
        self.store = store
        self.price_per_1k = price_per_1k
        self.approval_window_s = approval_window_s

    # ---- tool-dispatch boundary (WRAP-ok) --------------------------------
    def gate(self, pending: ToolCall) -> ControlSignal:
        name = getattr(pending, "name", "")
        args = getattr(pending, "args", {}) or {}

        for rule in self.tool_gates:
            if rule.get("tool") in (name, "*") and match_when(rule.get("when") or {}, args):
                if (rule.get("action") or "deny") == "deny":
                    return ControlSignal(action="kill", reason=f"TOOL_DENIED:{name}")

        for rule in self.approvals:
            if rule.get("tool") in (name, "*") and match_when(rule.get("when") or {}, args):
                return self._approval(name, args, rule)

        return ControlSignal(action="continue")

    def _approval(self, name: str, args: dict, rule: dict) -> ControlSignal:
        if self.store is None:
            return ControlSignal(action="kill", reason="APPROVAL_STORAGE_REQUIRED")
        held_key = f"_held/{self.run_id}"
        held = self.store.get(held_key)
        action = json.dumps({"tool": name, "args": args}, sort_keys=True, allow_nan=False)
        if held is None or not held.get("approval_id"):
            # Upgrade legacy holds by requiring a fresh review, never trusting an
            # unbound decision left by an older worker.
            approval_id = uuid.uuid4().hex
            deadline = (time.time() + self.approval_window_s) if self.approval_window_s else None
            replacement = {"run": self.run_id, "tool": name, "args": args, "rule": rule,
                           "deadline": deadline, "approval_id": approval_id, "action": action,
                           "gate_key": f"_held/{self.run_id}/{approval_id}"}
            self.store.compare_and_set(held_key, held, replacement)
            return ControlSignal(action="pause", reason=f"AWAIT_APPROVAL:{name}")
        if held.get("action") != action:
            return ControlSignal(action="kill", reason="APPROVAL_ACTION_CHANGED")
        if held.get("deadline") is not None and time.time() >= held["deadline"]:
            return ControlSignal(action="kill", reason="APPROVAL_EXPIRED")
        gate_key = held["gate_key"]
        d = self.store.get(gate_key)
        if d is None:
            return ControlSignal(action="pause", reason=f"AWAIT_APPROVAL:{name}")
        if (d.get("approval_id") != held["approval_id"] or d.get("tool") != name
                or json.dumps({"tool": d.get("tool"), "args": d.get("original_args")},
                              sort_keys=True, allow_nan=False) != action):
            return ControlSignal(action="kill", reason="APPROVAL_ACTION_CHANGED")
        if d.get("consumed_at") is not None or not self.store.compare_and_set(
                gate_key, d, {**d, "consumed_at": time.time()}):
            return ControlSignal(action="kill", reason="APPROVAL_ALREADY_CONSUMED")
        # Keep the consumed decision as an audit record. Claim it BEFORE dispatch.
        self.store.compare_and_set(held_key, held, None)
        verdict = d.get("decision")
        if verdict == "approve":
            return ControlSignal(action="continue")
        if verdict == "edit":
            if not isinstance(d.get("args"), dict):
                return ControlSignal(action="kill", reason="APPROVAL_INVALID_EDIT")
            return ControlSignal(action="override", override_args=d["args"])
        if verdict == "override":
            return ControlSignal(action="override", override_result=d.get("result"))
        if verdict == "skip":
            return ControlSignal(action="override", override_result=d.get("result", None))
        return ControlSignal(action="kill", reason=f"DENIED:{name}")  # deny / unknown

    # ---- between steps (budget/$ stop is OWN-only, C1) -------------------
    def evaluate(self, history: list[StepEvent]) -> ControlSignal:
        if self.max_steps and len(history) >= self.max_steps:
            return ControlSignal(action="kill", reason="MAX_STEPS")
        tokens = sum(e.tokens for e in history)
        if self.budget_tokens and tokens > self.budget_tokens:
            return ControlSignal(action="kill", reason="BUDGET_TOKENS")
        if self.budget_usd and self.price_per_1k:
            usd = tokens / 1000.0 * self.price_per_1k
            if usd > self.budget_usd:
                return ControlSignal(action="kill", reason="BUDGET_USD")
        return ControlSignal(action="continue")
