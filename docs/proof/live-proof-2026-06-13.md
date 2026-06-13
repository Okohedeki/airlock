# airlock live proof — over a REAL public Cloudflare URL (2026-06-13)

> **Not localhost.** A real `openai`-harness model loop, exposed on a real Cloudflare quick
> tunnel (zero Cloudflare account), driven by `curl` against the public address below. The URL
> was ephemeral and is gone now — this transcript is the durable evidence. Reproduce:
> `bash scripts/live-proof.sh`.

**Public URL:** `https://sessions-manual-ltd-lifestyle.trycloudflare.com`  ·  **Harness:** `openai` (airlock OWNS the loop)  ·  **Model:** local mock (deterministic)

## Health — the public URL is live
```
$ curl -s https://sessions-manual-ltd-lifestyle.trycloudflare.com/healthz
{"ok":true}
```

## Manifest — harness + public expose, reported over the public URL
```json
{
  "name": "live-proof",
  "version": "0.1.0",
  "harness": "openai",
  "expose": "public",
  "models": [
    "primary",
    "fast",
    "backup"
  ],
  "tools": [
    "echo",
    "send",
    "slow"
  ],
  "controls": {
    "max_steps": 8,
    "budget": null,
    "tool_gates": [
      {
        "tool": "echo",
        "when": {
          "text": {
            "contains": "rm -rf"
          }
        },
        "action": "deny"
      }
    ],
    "approvals": [
      "send"
    ]
  },
  "routing": {
    "default": "primary"
  },
  "tenants": [
    "acme",
    "globex"
  ],
  "auth": "api_key"
}
```

## Epic 01 — airlock owns a REAL model loop (model → tool_result → final)
```json
{
  "id": "chatcmpl-d015e3bc6ab94b41a38031e5",
  "object": "chat.completion",
  "created": 1781336097,
  "model": "live-proof",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "[m-primary] TOOLCALL:echo:{\"text\":\"hello from the public web\"}"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 14,
    "completion_tokens": 10,
    "total_tokens": 24
  },
  "steps": [
    {
      "index": 0,
      "type": "model",
      "input": [
        {
          "role": "user",
          "content": "TOOLCALL:echo:{\"text\":\"hello from the public web\"}"
        }
      ],
      "output": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "c1",
            "type": "function",
            "function": {
              "name": "echo",
              "arguments": "{\"text\":\"hello from the public web\"}"
            }
          }
        ]
      },
      "tokens": 12,
      "prompt_tokens": 7,
      "completion_tokens": 5,
      "duration_ms": 3.401,
      "cost_usd": 0.0,
      "status": "ok",
      "tool": null,
      "model": "m-primary",
      "error": null
    },
    {
      "index": 1,
      "type": "tool_result",
      "input": {
        "text": "hello from the public web"
      },
      "output": "hello from the public web",
      "tokens": 0,
      "prompt_tokens": 0,
      "completion_tokens": 0,
      "duration_ms": 0.06,
      "cost_usd": 0.0,
      "status": "ok",
      "tool": "echo",
      "model": null,
      "error": null
    },
    {
      "index": 2,
      "type": "model",
      "input": [
        {
          "role": "user",
          "content": "TOOLCALL:echo:{\"text\":\"hello from the public web\"}"
        },
        {
          "role": "tool",
          "name": "echo",
          "content": "\"hello from the public web\""
        }
      ],
      "output": {
        "role": "assistant",
        "content": "[m-primary] TOOLCALL:echo:{\"text\":\"hello from the public web\"}"
      },
      "tokens": 12,
      "prompt_tokens": 7,
      "completion_tokens": 5,
      "duration_ms": 0.967,
      "cost_usd": 0.0,
      "status": "ok",
      "tool": null,
      "model": "m-primary",
      "error": null
    },
    {
      "index": 3,
      "type": "final",
      "input": null,
      "output": "[m-primary] TOOLCALL:echo:{\"text\":\"hello from the public web\"}",
      "tokens": 0,
      "prompt_tokens": 0,
      "completion_tokens": 0,
      "duration_ms": 0.0,
      "cost_usd": 0.0,
      "status": "ok",
      "tool": null,
      "model": null,
      "error": null
    }
  ]
}
```

## Epic 02 — tool gating: a dangerous argument is DENIED mid-loop (status: killed)
```json
{
  "id": "chatcmpl-c22c079ab34e43b2a9858f2d",
  "object": "chat.completion",
  "created": 1781336098,
  "model": "live-proof",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": ""
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 7,
    "completion_tokens": 5,
    "total_tokens": 12
  },
  "steps": [
    {
      "index": 0,
      "type": "model",
      "input": [
        {
          "role": "user",
          "content": "TOOLCALL:echo:{\"text\":\"rm -rf /\"}"
        }
      ],
      "output": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "c1",
            "type": "function",
            "function": {
              "name": "echo",
              "arguments": "{\"text\":\"rm -rf /\"}"
            }
          }
        ]
      },
      "tokens": 12,
      "prompt_tokens": 7,
      "completion_tokens": 5,
      "duration_ms": 1.28,
      "cost_usd": 0.0,
      "status": "ok",
      "tool": null,
      "model": "m-primary",
      "error": null
    },
    {
      "index": 1,
      "type": "tool_call",
      "input": {
        "text": "rm -rf /"
      },
      "output": null,
      "tokens": 0,
      "prompt_tokens": 0,
      "completion_tokens": 0,
      "duration_ms": 0.0,
      "cost_usd": 0.0,
      "status": "killed",
      "tool": "echo",
      "model": null,
      "error": "TOOL_DENIED:echo"
    }
  ]
}
```

## Epic 02 — mid-run approval: fire → BLOCKED (parks for a human)
```json
{
  "id": "chatcmpl-0e9b09ac14db41e4b1ce35e0",
  "object": "chat.completion",
  "created": 1781336098,
  "model": "live-proof",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": ""
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 7,
    "completion_tokens": 5,
    "total_tokens": 12
  },
  "steps": [
    {
      "index": 0,
      "type": "model",
      "input": [
        {
          "role": "user",
          "content": "TOOLCALL:send:{\"to\":\"ceo@example.com\",\"body\":\"ship it\"}"
        }
      ],
      "output": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "c1",
            "type": "function",
            "function": {
              "name": "send",
              "arguments": "{\"to\":\"ceo@example.com\",\"body\":\"ship it\"}"
            }
          }
        ]
      },
      "tokens": 12,
      "prompt_tokens": 7,
      "completion_tokens": 5,
      "duration_ms": 1.267,
      "cost_usd": 0.0,
      "status": "ok",
      "tool": null,
      "model": "m-primary",
      "error": null
    },
    {
      "index": 1,
      "type": "tool_call",
      "input": {
        "to": "ceo@example.com",
        "body": "ship it"
      },
      "output": null,
      "tokens": 0,
      "prompt_tokens": 0,
      "completion_tokens": 0,
      "duration_ms": 0.0,
      "cost_usd": 0.0,
      "status": "blocked",
      "tool": "send",
      "model": null,
      "error": "AWAIT_APPROVAL:send"
    }
  ]
}
```

## Epic 02 — the held queue (awaiting a human decision)
```json
{
  "held": [
    {
      "run": "approve-live",
      "tool": "send",
      "args": {
        "to": "ceo@example.com",
        "body": "ship it"
      },
      "rule": {
        "tool": "send"
      },
      "deadline": null,
      "gate_key": "_held/approve-live/send"
    }
  ]
}
```

## Epic 02 — approve it
```json
{
  "ok": true,
  "run": "approve-live",
  "decision": "approve"
}
```

## Epic 02 — resume the SAME run → completes (note [REDACTED:email] output redaction)
```json
{
  "id": "chatcmpl-bef5ea5d2425458d8d4149bf",
  "object": "chat.completion",
  "created": 1781336099,
  "model": "live-proof",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "[m-primary] TOOLCALL:send:{\"to\":\"[REDACTED:email]\",\"body\":\"ship it\"}"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 14,
    "completion_tokens": 10,
    "total_tokens": 24
  },
  "steps": [
    {
      "index": 0,
      "type": "model",
      "input": [
        {
          "role": "user",
          "content": "TOOLCALL:send:{\"to\":\"ceo@example.com\",\"body\":\"ship it\"}"
        }
      ],
      "output": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "c1",
            "type": "function",
            "function": {
              "name": "send",
              "arguments": "{\"to\":\"ceo@example.com\",\"body\":\"ship it\"}"
            }
          }
        ]
      },
      "tokens": 12,
      "prompt_tokens": 7,
      "completion_tokens": 5,
      "duration_ms": 1.154,
      "cost_usd": 0.0,
      "status": "ok",
      "tool": null,
      "model": "m-primary",
      "error": null
    },
    {
      "index": 1,
      "type": "tool_result",
      "input": {
        "to": "ceo@example.com",
        "body": "ship it"
      },
      "output": {
        "sent_to": "ceo@example.com",
        "body": "ship it"
      },
      "tokens": 0,
      "prompt_tokens": 0,
      "completion_tokens": 0,
      "duration_ms": 0.05,
      "cost_usd": 0.0,
      "status": "ok",
      "tool": "send",
      "model": null,
      "error": null
    },
    {
      "index": 2,
      "type": "model",
      "input": [
        {
          "role": "user",
          "content": "TOOLCALL:send:{\"to\":\"ceo@example.com\",\"body\":\"ship it\"}"
        },
        {
          "role": "tool",
          "name": "send",
          "content": "{\"sent_to\": \"ceo@example.com\", \"body\": \"ship it\"}"
        }
      ],
      "output": {
        "role": "assistant",
        "content": "[m-primary] TOOLCALL:send:{\"to\":\"ceo@example.com\",\"body\":\"ship it\"}"
      },
      "tokens": 12,
      "prompt_tokens": 7,
      "completion_tokens": 5,
      "duration_ms": 0.887,
      "cost_usd": 0.0,
      "status": "ok",
      "tool": null,
      "model": "m-primary",
      "error": null
    },
    {
      "index": 3,
      "type": "final",
      "input": null,
      "output": "[m-primary] TOOLCALL:send:{\"to\":\"ceo@example.com\",\"body\":\"ship it\"}",
      "tokens": 0,
      "prompt_tokens": 0,
      "completion_tokens": 0,
      "duration_ms": 0.0,
      "cost_usd": 0.0,
      "status": "ok",
      "tool": null,
      "model": null,
      "error": null
    }
  ]
}
```

## Epic 07/10 — skill ACLs over the public URL
```
POST /skills/calc -> 200
POST /skills/danger -> 403
POST /skills/nope -> 404
```

## Epic 05 — live SSE step streaming over the tunnel
```
data: {"id": "chatcmpl-e133827a15614dbc88ce6567", "object": "chat.completion.chunk", "created": 1781336099, "model": "live-proof", "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": null}]}

event: step
data: {"index": 0, "type": "model", "input": [{"role": "user", "content": "TOOLCALL:echo:{\"text\":\"streamed\"}"}], "output": {"role": "assistant", "content": null, "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "echo", "arguments": "{\"text\":\"streamed\"}"}}]}, "tokens": 12, "prompt_tokens": 7, "completion_tokens": 5, "duration_ms": 1.753, "cost_usd": 0.0, "status": "ok", "tool": null, "model": "m-primary", "error": null}

event: step
data: {"index": 1, "type": "tool_result", "input": {"text": "streamed"}, "output": "streamed", "tokens": 0, "prompt_tokens": 0, "completion_tokens": 0, "duration_ms": 0.059, "cost_usd": 0.0, "status": "ok", "tool": "echo", "model": null, "error": null}

event: step
data: {"index": 2, "type": "model", "input":
```
