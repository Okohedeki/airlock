"""Durable jobs for one worker owning a local SQLite store."""

import time


def recover_jobs(store) -> int:
    """Call only under exclusive store ownership, before accepting requests.

    A stale running job might already have produced external effects. Preserve
    its input and execution records, and require review rather than rerunning it.
    """
    recovered = 0
    for key in store.list_prefix(""):
        if not key.partition("/")[2].startswith("_jobs/"):
            continue
        job = store.get(key)
        if not job or job.get("status") != "running":
            continue
        job.update(status="interrupted", updated_at=time.time(),
                   error="Worker stopped before recording completion; review effects before retrying.")
        store.set(key, job)
        recovered += 1
    return recovered


def execute_job(store, job: dict, call) -> None:
    """Execute once in a worker thread; persist the outcome independently of HTTP."""
    try:
        result = call(job["messages"], None)
        steps = result.steps or []
        reason = next((s.get("stop_reason") for s in reversed(steps)
                       if s.get("stop_reason")), None)
        if reason and reason.startswith("AWAIT"):
            status = "awaiting_approval"
        elif any(s.get("status") == "blocked" for s in steps):
            status = "blocked"
        elif reason or any(s.get("status") == "killed" for s in steps):
            status = "stopped"
        elif any(s.get("status") == "error" for s in steps):
            status = "failed"
        else:
            status = "completed"
        job.update(status=status, stop_reason=reason,
                   result={"content": result.content, "tokens": result.units})
    except Exception as exc:
        # Exception messages can contain credentials/provider request details.
        # An exception does not prove that a tool produced no external effect.
        job.update(status="failed", error_type=type(exc).__name__,
                   error="Execution failed; review recorded effects before retrying.")
    job["updated_at"] = time.time()
    store.scoped(job["tenant"]).set(f"_jobs/{job['job_id']}", job)
