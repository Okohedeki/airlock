"""Durable jobs for one worker owning a local SQLite store."""

import logging
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager

from .state.ownership import exclusive_owner
from .state.sqlite import SQLiteStore


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


def submit_job(store, executor, call, *, tenant, session, job_id, messages, release):
    """Persist before scheduling; take ownership of an already acquired run slot.

    The caller releases its slot if this function raises. After success, the
    future releases it even if the client disconnects or persistence fails.
    """
    now = time.time()
    job = {"job_id": job_id, "run_id": job_id, "tenant": tenant, "session": session,
           "messages": messages, "status": "running", "created_at": now, "updated_at": now}
    scoped = store.scoped(tenant)
    scoped.set(f"_jobs/{job_id}", job)
    try:
        future = executor.submit(execute_job, store, job, call)
    except Exception:
        job.update(status="failed", error="Worker could not schedule execution.")
        scoped.set(f"_jobs/{job_id}", job)
        raise

    def finished(future):
        try:
            error = future.exception()
            if error is not None:
                logging.getLogger(__name__).error(
                    "Job %s could not record its outcome (%s); review before retrying",
                    job_id, type(error).__name__)
        finally:
            release()

    future.add_done_callback(finished)
    return {"job_id": job_id, "run_id": job_id, "status": "accepted",
            "url": f"/v1/jobs/{job_id}"}


@contextmanager
def job_worker(store, max_concurrency: int):
    """Own recovery and drain threads before releasing storage on shutdown.

    An in-memory store cannot fulfill the durability contract: leave jobs
    unavailable while allowing the existing synchronous chat API to operate.
    """
    if not isinstance(store, SQLiteStore) or store.path is None:
        yield None
        return
    with exclusive_owner(store.path + ".jobs.lock"):
        recover_jobs(store)
        with ThreadPoolExecutor(max_workers=max(1, max_concurrency),
                                thread_name_prefix="airlock-job") as executor:
            yield executor


def continue_job(store, executor, runner, job: dict, review_id: str, release):
    """Claim one held job, preserving its prior run while recording a new attempt."""
    if job.get("status") != "awaiting_approval":
        raise ValueError("only a job awaiting approval can continue")
    scoped = store.scoped(job["tenant"])
    held = scoped.get(f"_held/{job['job_id']}")
    if not held or held.get("approval_id") != review_id:
        raise ValueError("approval changed; refresh before continuing")
    if held.get("deadline") is not None and time.time() >= held["deadline"]:
        raise ValueError("approval expired")
    decision = scoped.get(held["gate_key"])
    if not decision or decision.get("consumed_at") is not None:
        raise ValueError("record an operator decision before continuing")
    run_id = f"{job['job_id']}-c-{uuid.uuid4().hex}"
    attempt = {**job, "run_id": run_id, "status": "running", "updated_at": time.time(),
               "previous_run_ids": [*(job.get("previous_run_ids") or []), job["run_id"]]}
    for key in ("result", "error", "error_type", "stop_reason"):
        attempt.pop(key, None)
    if not scoped.compare_and_set(f"_jobs/{job['job_id']}", job, attempt):
        raise ValueError("job already changed or is being continued")

    def call(messages, on_step):
        return runner.continue_run(job["run_id"], new_run_id=run_id, tenant=job["tenant"],
                                   approval_run_id=job["job_id"], review_id=review_id, on_step=on_step)

    try:
        future = executor.submit(execute_job, store, attempt, call)
    except Exception:
        scoped.set(f"_jobs/{job['job_id']}", {**attempt, "status": "failed",
                                           "error": "Worker could not schedule continuation."})
        raise

    def finished(future):
        try:
            if future.exception() is not None:
                logging.getLogger(__name__).error("Job %s could not persist continuation outcome", job["job_id"])
        finally:
            release()

    future.add_done_callback(finished)
    return {"job_id": job["job_id"], "run_id": run_id, "status": "accepted",
            "url": f"/v1/jobs/{job['job_id']}"}
