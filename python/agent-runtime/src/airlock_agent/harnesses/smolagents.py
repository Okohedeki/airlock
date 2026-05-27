"""Driver for a smolagents agent (e.g. CodeAgent). Operates on a pre-built agent
and runs its full native loop. Usage is read from THIS run's result
(`RunResult.token_usage`, summed over the run's own steps) rather than a delta on
the agent's cumulative `monitor` — the old delta raced under concurrency and
mis-billed. See ADR-0010.
"""

from __future__ import annotations

from typing import Any

from ..adapter import AgentRunResult, messages_to_task


def _steps(agent: Any) -> int:
    try:
        return len(agent.memory.steps)
    except Exception:
        return 0


def drive(agent: Any, messages: list[dict[str, Any]]) -> AgentRunResult:
    task = messages_to_task(messages)
    # smolagents >= ~1.10: return_full_result yields a RunResult whose token_usage
    # is summed over THIS run's steps — no shared cumulative counter.
    try:
        result = agent.run(task, reset=True, return_full_result=True)
    except TypeError:
        # Older smolagents (no return_full_result / no reset kwarg).
        try:
            answer = agent.run(task, reset=True)
        except TypeError:
            answer = agent.run(task)
        return AgentRunResult(content=str(answer), units=_steps(agent), unit_label="steps")

    output = getattr(result, "output", result)
    tu = getattr(result, "token_usage", None)
    total = int(getattr(tu, "total_tokens", 0) or 0) if tu is not None else 0
    if total > 0:
        prompt = int(getattr(tu, "input_tokens", 0) or 0)
        completion = int(getattr(tu, "output_tokens", 0) or 0)
        return AgentRunResult(
            content=str(output),
            units=total,
            unit_label="tokens",
            prompt_tokens=prompt,
            completion_tokens=completion,
        )
    # token_usage is None when a step lacks usage (some local models); bill by steps.
    n = len(getattr(result, "steps", []) or []) or _steps(agent)
    return AgentRunResult(content=str(output), units=n, unit_label="steps")
