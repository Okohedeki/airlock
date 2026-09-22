"""Process ownership for a local job store; the OS releases it after a crash."""

import os
from contextlib import contextmanager


@contextmanager
def exclusive_owner(path: str):
    """Hold a nonblocking lock on a persistent sidecar file (never unlink it).

    This is for local filesystems, not distributed or network storage.
    A second worker must fail startup instead of recovering a live worker's jobs.
    """
    handle = open(path, "a+b")
    try:
        if os.name == "nt":
            import msvcrt

            if os.fstat(handle.fileno()).st_size == 0:
                handle.write(b"\0")
                handle.flush()
            handle.seek(0)
            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as exc:
                raise RuntimeError("job store already owned by another worker") from exc
        else:
            import fcntl

            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                raise RuntimeError("job store already owned by another worker") from exc
        yield
    finally:
        # Closing releases the lock, including when the body raises.
        handle.close()
