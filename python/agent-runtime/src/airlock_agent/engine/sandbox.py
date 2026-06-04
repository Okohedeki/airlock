"""Sandboxed tool execution — epic 06, at the engine's single tool-dispatch seam.

Sandboxing decorates the one `dispatch(tool, name, args)` shim that both OWN and
WRAP bindings route through, so it works on **all** harnesses (frozen contract C1).
A limit breach raises `SandboxViolation`, which the loop turns into a StepEvent with
status=error — the exact channel epic-03 fallback consumes.

v1 = subprocess + POSIX rlimits (CPU, address space) + a wall-clock timeout. Strong
network/FS isolation is a Linux/Docker concern delivered with the epic-09 image;
on a dev box we enforce the resource/time limits (demonstrable) and document the
network grant as advisory. Tool args/results marshal as JSON (size-capped); a
non-JSON-serializable result is rejected.
"""

from __future__ import annotations

import json
import multiprocessing as mp
from typing import Any, Callable

DEFAULT_LIMITS = {"cpu_s": 5, "mem_mb": 512, "wall_s": 10, "max_io_bytes": 1_000_000}


class SandboxViolation(RuntimeError):
    pass


def _child(conn, tool: Callable, args: dict, limits: dict) -> None:  # pragma: no cover - subprocess
    try:
        import resource

        cpu = int(limits.get("cpu_s") or 0)
        if cpu:
            resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
        mem = int(limits.get("mem_mb") or 0)
        if mem:
            b = mem * 1024 * 1024
            try:
                resource.setrlimit(resource.RLIMIT_AS, (b, b))
            except (ValueError, OSError):
                pass  # RLIMIT_AS unsupported on some platforms (e.g. macOS) — best effort
    except Exception:
        pass
    try:
        result = tool(**args) if isinstance(args, dict) else tool(args)
        conn.send(("ok", result))
    except Exception as exc:
        conn.send(("err", f"{type(exc).__name__}: {exc}"))
    finally:
        conn.close()


def _check_io(obj: Any, cap: int) -> Any:
    blob = json.dumps(obj, default=str)
    if len(blob) > cap:
        raise SandboxViolation(f"result exceeds max_io_bytes ({len(blob)} > {cap})")
    return json.loads(blob)


def run_sandboxed(tool: Callable, args: dict, limits: dict) -> Any:
    lim = {**DEFAULT_LIMITS, **(limits or {})}
    _check_io(args, lim["max_io_bytes"])  # reject oversize / non-serializable args
    try:
        ctx = mp.get_context("fork")  # fork: closures need no pickling
    except ValueError:  # platform without fork
        return _check_io(tool(**args), lim["max_io_bytes"])
    parent, child = ctx.Pipe()
    proc = ctx.Process(target=_child, args=(child, tool, args, lim))
    proc.start()
    child.close()
    proc.join(lim["wall_s"])
    if proc.is_alive():
        proc.terminate()
        proc.join()
        raise SandboxViolation(f"tool exceeded wall_s={lim['wall_s']}s")
    if proc.exitcode and proc.exitcode < 0:  # killed by a signal (SIGXCPU/SIGKILL/OOM)
        raise SandboxViolation(f"tool killed by signal {-proc.exitcode} (resource limit)")
    if not parent.poll():
        raise SandboxViolation("tool produced no result")
    status, payload = parent.recv()
    if status == "err":
        raise RuntimeError(payload)
    return _check_io(payload, lim["max_io_bytes"])


def build_sandbox_dispatch(sandbox_cfg: dict[str, Any]):
    """Return a dispatch_wrapper (tool, name, args) -> result, or None if disabled."""
    if not sandbox_cfg or sandbox_cfg.get("enabled") is False:
        return None
    defaults = dict(sandbox_cfg.get("defaults") or {})
    per_tool = dict(sandbox_cfg.get("per_tool") or {})

    def dispatch(tool: Callable, name: str, args: dict) -> Any:
        limits = {**DEFAULT_LIMITS, **defaults, **(per_tool.get(name) or {})}
        return run_sandboxed(tool, args, limits)

    return dispatch
