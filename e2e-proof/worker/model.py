"""Deterministic OpenAI-compatible mock model for the e2e proof (stdlib only).

Echoes the `model` name it received (so routing/fallback is visible), returns a
tool_call when the user message contains `TOOLCALL:<name>:<json>`, and optionally
sleeps MOCK_DELAY seconds per call so the concurrency/queueing test has slow runs.

Run:  python model.py --port 8999       (MOCK_DELAY=2 to slow each call)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DELAY = float(os.environ.get("MOCK_DELAY", "0"))


def handle(payload: dict) -> dict:
    model = payload.get("model") or "mock"
    messages = payload.get("messages") or []
    answered = any(m.get("role") == "tool" for m in messages)
    last = next((m.get("content", "") for m in reversed(messages) if m.get("role") == "user"), "")
    m = re.search(r"TOOLCALL:([\w.-]+):(\{.*\})", last or "")
    if m and not answered:
        msg = {"role": "assistant", "content": None,
               "tool_calls": [{"id": "c1", "type": "function",
                               "function": {"name": m.group(1), "arguments": m.group(2)}}]}
    else:
        msg = {"role": "assistant", "content": f"[{model}] {last}"}
    return {"id": "chatcmpl-mock", "object": "chat.completion", "model": model,
            "choices": [{"index": 0, "message": msg, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 7, "completion_tokens": 5, "total_tokens": 12}}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def do_POST(self):
        if DELAY:
            time.sleep(DELAY)
        n = int(self.headers.get("Content-Length", 0))
        body = json.dumps(handle(json.loads(self.rfile.read(n) or b"{}"))).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8999)
    ap.add_argument("--host", default=os.environ.get("MOCK_MODEL_HOST", "0.0.0.0"))
    args = ap.parse_args()
    srv = ThreadingHTTPServer((args.host, args.port), H)
    print(f"mock model on http://{args.host}:{args.port}/v1/chat/completions  (delay={DELAY}s)", flush=True)
    srv.serve_forever()
