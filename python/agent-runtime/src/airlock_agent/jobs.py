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
