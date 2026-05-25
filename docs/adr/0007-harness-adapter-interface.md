# Harness integration via a reusable adapter interface

To deploy *agentic processes* (not just single LLM calls), airlock exposes every Agent behind an OpenAI-compatible `POST /v1/chat/completions` surface and binds the Publisher's Harness (LangGraph, CrewAI, smolagents, …) to it through a small reusable **`HarnessAdapter`** interface — `run(messages) -> { content, usage, steps? }`, which executes the Harness's *full native loop* (hooks, tool-calling, multi-step) server-side. The chat surface, payment, and well-known serving are written once in a shared `airlock-agent` package; each Harness is a thin (~30-line) adapter. We chose this over a template-per-harness approach because the goal is to support *many* harnesses: copying the surface per harness would duplicate payment/usage/serving wiring and drift immediately.

## Considered Options

- **Template-per-harness (rejected).** Fork a full service per framework. Simple for one harness; duplicates the surface N times and fights the multi-harness goal.
- **Reusable adapter interface + shared surface (accepted).** One surface, N thin adapters. Adding a harness is a small adapter, not a forked server.

## Consequences

- The adapter must run the Harness's native loop faithfully — never flatten an agentic run into a single model call.
- Per-harness specifics (mapping `messages[]` to the harness's input, summing token/step usage) live in each adapter and are version-coupled to that framework; pin versions and isolate the mapping.
