# airlock control plane — live worker control (2026-06-14)

The operator console (/console) drives a live control plane that mutates a RUNNING worker
without rewriting worker.yaml. Captured below: GET /v1/control after a few live toggles.
```json
{
    "worker": {
        "name": "live-proof",
        "version": "0.1.0"
    },
    "harness": "openai",
    "control_mode": "own",
    "expose": "public",
    "models": {
        "bindings": [
            {
                "name": "primary",
                "model": "m-primary",
                "endpoint": "http://127.0.0.1:8999/v1/chat/completions"
            },
            {
                "name": "fast",
                "model": "m-fast",
                "endpoint": "http://127.0.0.1:8999/v1/chat/completions"
            },
            {
                "name": "backup",
                "model": "m-backup",
                "endpoint": "http://127.0.0.1:8999/v1/chat/completions"
            }
        ],
        "default": "backup"
    },
    "skills": [
        {
            "id": "calc",
            "tool": "echo",
            "enabled": false
        },
        {
            "id": "mailer",
            "tool": "send",
            "enabled": true
        },
        {
            "id": "danger",
            "tool": "slow",
            "enabled": false
        }
    ],
    "controls": {
        "max_steps": 8,
        "budget": {
            "usd": 0.5
        },
        "approvals": [
            "echo",
            "send"
        ],
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
        "approval_window_s": 0
    },
    "io": {
        "input_guards": false,
        "redact": [
            "email"
        ]
    },
    "tools": [
        "send"
    ],
    "overrides": {
        "skills": {
            "calc": false
        },
        "controls": {
            "approval:echo": true,
            "budget.usd": 0.5
        },
        "routing": {
            "default": "backup"
        }
    }
}
```
