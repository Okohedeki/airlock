"""`python -m airlock_agent` — the container entry point.

Reads `.airlock/config.toml [agent]`, imports the developer's agent, selects the
built-in driver for `harness`, and serves the OpenAI-compatible surface. The
developer writes no app.py and no adapter — just the `[agent]` config block.

Isolation under concurrency comes from PER-CALL REBUILD (ADR-0010): for a factory
entrypoint the runtime constructs a fresh agent wrapper each request around the
one shared (out-of-process) model, so concurrent requests never share state. If
the entrypoint is a bare instance, or its build is slow enough to look like it
loads weights in-process, we fall back to a single shared object governed by the
per-driver reentrancy policy.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any

from .adapter import AgentRunResult
from .concurrency import (
    read_build_per_call,
    read_max_concurrency,
    read_max_queue,
    read_max_wait,
    resolve_policy,
)
from .config import read_agent_config
from .harnesses import Driver, get_driver, is_reentrant
from .loader import Builder, resolve_builder
from .surface import create_app

log = logging.getLogger("airlock_agent")

# A startup build slower than this looks like in-process weight loading; per-call
# rebuild would reload it every request, so we disable per-call rebuild and warn.
SLOW_BUILD_SECONDS = 1.5


class _DriverAdapter:
    """Wraps a (driver, Builder) pair as a HarnessAdapter for the surface.

    With `build_per_call`, `run` builds a fresh object each request (isolation);
    otherwise it reuses the single object built at startup.
    """

    def __init__(self, driver: Driver, builder: Builder, sample: Any, build_per_call: bool) -> None:
        self._driver = driver
        self._builder = builder
        self._sample = sample
        self._build_per_call = build_per_call

    def run(self, messages: list[dict[str, Any]]) -> AgentRunResult:
        obj = self._builder.build() if self._build_per_call else self._sample
        return self._driver(obj, messages)


def build_app(cwd: str | None = None):
    cfg = read_agent_config(cwd)
    harness = cfg.get("harness")
    entrypoint = cfg.get("entrypoint")
    if not harness or not entrypoint:
        raise SystemExit(
            "no [agent] block in .airlock/config.toml — need `harness` and `entrypoint`. "
            "Run `airlock init` to detect and write it."
        )
    harness = str(harness)
    builder = resolve_builder(str(entrypoint), harness)

    # Build once at startup: validates the entrypoint and times the build.
    t0 = time.monotonic()
    sample = builder.build()
    build_secs = time.monotonic() - t0

    build_per_call = read_build_per_call(is_factory=builder.is_factory)
    if build_per_call and builder.is_factory and build_secs > SLOW_BUILD_SECONDS:
        log.warning(
            "airlock: agent build took %.1fs — looks like the model loads in-process; "
            "disabling per-call rebuild (would reload it every request). Run your model "
            "as a server (e.g. llama-server --parallel) to enable parallel isolation.",
            build_secs,
        )
        build_per_call = False

    if build_per_call:
        # Fresh object per request → every harness is isolated → uniform cap.
        max_concurrency = read_max_concurrency()
    else:
        # One shared object → fall back to the per-driver reentrancy policy.
        max_concurrency = resolve_policy(reentrant=is_reentrant(harness)).effective

    adapter = _DriverAdapter(get_driver(harness), builder, sample, build_per_call)
    # The wait budget doubles as the hard ceiling on how long an admitted caller
    # blocks, so admission and the await agree on one number.
    budget = read_max_wait()
    return create_app(
        adapter,
        name=harness,
        max_concurrency=max_concurrency,
        max_queue=read_max_queue(),
        queue_timeout_s=budget,
        max_wait_s=budget,
    )


def main() -> None:
    import uvicorn

    uvicorn.run(build_app(), host="0.0.0.0", port=int(os.environ.get("PORT", "3000")))


if __name__ == "__main__":
    main()
