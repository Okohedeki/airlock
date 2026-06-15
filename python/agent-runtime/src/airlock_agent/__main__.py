"""`python -m airlock_agent` — the container entry point (epic 07).

Boots a Worker entirely from `worker.yaml`: loads the manifest (CLI-validated; the
runtime trusts it), opens the state store, builds the EngineRunner, and
serves the OpenAI-compatible surface. Airlock owns the loop.
"""

from __future__ import annotations

import logging
import os

from .concurrency import read_max_concurrency, read_max_queue, read_max_wait
from .harnesses import control_mode, is_reentrant
from .manifest import Manifest
from .runner import EngineRunner
from .state import open_store
from .surface import create_app

log = logging.getLogger("airlock_agent")


def build_app(cwd: str | None = None):
    manifest = Manifest.load(cwd)
    state_cfg = manifest.state_config()
    store = open_store(state_cfg.get("backend", "sqlite"), state_cfg.get("dsn"))
    runner = EngineRunner(manifest, store)

    harness = manifest.harness()
    # OWN bindings rebuild a fresh binding per request (isolation); concurrency is the
    # full configured cap. WRAP/shared bindings fall back to the reentrancy policy.
    if control_mode(harness).value == "own" or is_reentrant(harness):
        max_concurrency = read_max_concurrency()
    else:
        from .concurrency import resolve_policy

        max_concurrency = resolve_policy(reentrant=False).effective

    # epic 10 auth: build the tenant resolver if the manifest declares auth.
    authenticate = None
    if manifest.auth():
        from .auth import build_authenticator

        authenticate = build_authenticator(manifest.auth(), manifest.tenancy(), store)

    budget = read_max_wait()
    return create_app(
        runner,
        name=manifest.worker_name(),
        max_concurrency=max_concurrency,
        max_queue=read_max_queue(),
        queue_timeout_s=budget,
        max_wait_s=budget,
        authenticate=authenticate,
    )


def main() -> None:
    import uvicorn

    # Stream app + per-step logs to stdout (docker logs). Level via AIRLOCK_LOG_LEVEL
    # (default INFO); uvicorn's own config runs after and leaves these loggers intact.
    logging.basicConfig(
        level=os.environ.get("AIRLOCK_LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    uvicorn.run(build_app(), host="0.0.0.0", port=int(os.environ.get("PORT", "3000")))


if __name__ == "__main__":
    main()
