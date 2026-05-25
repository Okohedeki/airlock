# airlock-agent

Deploy an agentic process (LangGraph, CrewAI, smolagents, OpenAI Agents SDK,
Claude Agent SDK, or a custom harness) behind an OpenAI-compatible API with
in-process x402 payment and optional `airlock-config` discovery.

The developer writes no adapter and no `app.py`. They declare a `[agent]` block
in `.airlock/config.toml`:

```toml
[agent]
harness    = "langgraph"            # smolagents|langgraph|crewai|openai-agents|claude|custom
entrypoint = "my_app.agents:graph"  # import path to your agent object (or a build_* factory)
```

and run the config-driven server:

```bash
python -m airlock_agent
```

It imports the entrypoint once, drives the harness's full native loop on each
`POST /v1/chat/completions`, returns a standard chat completion, and reports
billable units via `X-Airlock-Units`. The model is supplied by the publisher
(`OPENAI_API_BASE` / their own key) — airlock never hosts inference.

See the repo root README and `docs/adr/0007`, `0008` for the design.
