"""A deterministic OpenAI-compatible model server (stdlib only).

Used by the functional tests so the `openai` OWN binding runs a real tool-calling
loop with no real model and no extra deps. Determinism makes loop plumbing,
per-step cost, and model-switching assertions reproducible.

Scripting via the last user message:
  contains "TOOLCALL:<name>:<json>"  -> respond with a tool_calls message
  otherwise                          -> respond with content "[<model>] <text>"

The response always echoes the `model` field it received, so a test that routes two
bindings at this server with different model names can prove which model ran.

Run standalone:  python -m tests.functional.mock_model --port 8999
"""

from __future__ import annotations

import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def _completion(model: str, content: str | None, tool_calls: list | None) -> dict:
    msg: dict = {"role": "assistant", "content": content}
    if tool_calls:
        msg["tool_calls"] = tool_calls
        msg["content"] = None
    return {
        "id": "chatcmpl-mock", "object": "chat.completion", "model": model,
        "choices": [{"index": 0, "message": msg, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 7, "completion_tokens": 5, "total_tokens": 12},
    }


def handle_payload(payload: dict) -> dict:
    model = payload.get("model") or "mock"
    messages = payload.get("messages") or []
    # Has a tool already answered (a tool message present)? Then finish.
    answered = any(m.get("role") == "tool" for m in messages)
    last_user = next((m.get("content", "") for m in reversed(messages)
                      if m.get("role") == "user"), "")
    m = re.search(r"TOOLCALL:([\w.-]+):(\{.*\})", last_user or "")
    if m and not answered:
        name, raw = m.group(1), m.group(2)
        tc = [{"id": "call_1", "type": "function",
               "function": {"name": name, "arguments": raw}}]
        return _completion(model, None, tc)
    return _completion(model, f"[{model}] {last_user}", None)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        payload = json.loads(self.rfile.read(length) or b"{}")
        body = json.dumps(handle_payload(payload)).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"ok":true}')


def serve(port: int = 0) -> ThreadingHTTPServer:
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    return srv


if __name__ == "__main__":
    import argparse
    import threading

    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8999)
    args = ap.parse_args()
    srv = serve(args.port)
    print(f"mock model on http://127.0.0.1:{srv.server_address[1]}/v1/chat/completions", flush=True)
    srv.serve_forever()
