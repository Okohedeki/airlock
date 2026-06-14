"""The local Operator Console (epic 05 / operator UX) — a static, no-build web UI
served at /console by the runtime surface.

Single-worker cockpit: Overview, Live (watch the loop stream step-by-step), Runs +
trace detail, Approvals (mid-run intervention), and an INTERACTIVE Control plane —
toggle skills on/off, switch the model binding, and adjust guards (max_steps, budget,
approvals) live, layered over the frozen worker.yaml. It is a thin client over the
surface's own HTTP API (/v1/manifest, /v1/control[/*], /v1/runs, /v1/runs/held,
/v1/runs/{id}/decision, /metrics, and the streaming /v1/chat/completions). Localhost
by default; same origin, so no CORS.
"""

from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.responses import HTMLResponse

_INDEX = os.path.join(os.path.dirname(__file__), "index.html")


def mount_console(app: FastAPI) -> None:
    with open(_INDEX) as f:
        html = f.read()

    @app.get("/console")
    def console() -> HTMLResponse:
        return HTMLResponse(html)
