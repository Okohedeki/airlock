# Harness showcase — one real worker per framework, containerized

This is a **production-grade, runnable example per harness**, each demonstrating airlock's
full control surface and **skills on/off**, backed by a **real local LLM** and a
**containerized test runner** that proves every harness green.

> **Prove it on the public web — not just localhost.** The container grid below runs on an
> internal Docker network (ports 3101–3106) for a hermetic, repeatable matrix. To see the
> *product* — a worker exposed on a real public URL — run **`bash scripts/live-proof.sh`**: it
> boots a real model loop, opens a Cloudflare tunnel, drives the whole control surface over the
> public `https://<rand>.trycloudflare.com` address, and saves a dated transcript under
> [`docs/proof/`](./proof/). The localhost ports here are the CI view; the public URL is the point.

Each example is a complete worker: `examples/<harness>/` holds `agent.py` (the harness's tools
+ factory), `requirements.txt` (the framework), and `worker.yaml` (the production manifest —
models, skills, controls, io, state). One container per harness keeps each framework's
dependencies isolated (crewai's deps conflict with the langchain stack).

## What each example shows

Every framework worker exposes a uniform 2-tool contract so the harnesses are comparable:

| Skill | Tool | State | Behavior |
| --- | --- | --- | --- |
| `calc` | `multiply` | **enabled** | `POST /skills/calc` → 200; the model can call `multiply` in the loop |
| `danger` | `danger` | **disabled** | `POST /skills/danger` → 403; the `danger` tool is **dropped from the loop** |

`POST /skills/<unknown>` → 404.

| Service | Port | Harness | Control mode | Notes |
| --- | --- | --- | --- | --- |
| langgraph | 3101 | `langgraph` | **OWN** | tools extracted, airlock drives the loop |
| smolagents | 3102 | `smolagents` | **OWN** | |
| crewai | 3103 | `crewai` | **OWN** | |
| openai-agents | 3104 | `openai-agents` | **OWN** | |
| claude | 3105 | `claude` | **OWN** | no Anthropic key — airlock drives its own model |
| custom | 3106 | `custom` | **Terminal** | a plain callable; observe-only, no mid-run control |

See [`CONTEXT.md`](../CONTEXT.md) for OWN / WRAP / Terminal.

## Prerequisite — a real local model

The showcase drives a **real** OpenAI-compatible, tool-calling model on the host at
`:11434`. For example, with llama.cpp:

```bash
llama-server -m ./models/Qwen2.5-3B-Instruct-Q4_K_M.gguf --port 11434 \
  --host 0.0.0.0 --jinja --alias local --parallel 6 --cont-batching -c 8192
```

A 3B+ model that supports tool/function calling is **required** — a 1B flails at tool use (it
emits malformed tool-call JSON that the server rejects, and loops without ever stating the
answer). `--parallel 6 --cont-batching` matters: the six harness containers hit this one server
concurrently, so without parallel slots some calls queue out and surface as 502s. With the
above, all **41 grid tests pass**. Containers reach the host via `host.docker.internal`.

To point at a different OpenAI-compatible endpoint instead, edit `OPENAI_API_BASE` in
`docker-compose.showcase.yml` (and each `worker.yaml` `models.default.endpoint`).

## Run it

```bash
# 1. build + start one container per harness (first build installs each framework)
docker compose -f docker-compose.showcase.yml up -d --build

# 2. run the containerized test runner — prints a PASS/FAIL row per harness
docker compose -f docker-compose.showcase.yml run --rm harness-tests

# 3. poke a single harness by hand
curl -s localhost:3101/v1/manifest | python3 -m json.tool
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3101/skills/danger -d '{"input":"x"}'   # 403
curl -s localhost:3101/v1/chat/completions -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"Use the multiply tool to compute 23 times 19."}]}'

# 4. tear down
docker compose -f docker-compose.showcase.yml down
```

## What the test runner asserts

For each OWN harness (`examples/showcase-tests/test_showcase.py`):

- **Strict (deterministic):** `/healthz`; `/v1/manifest` harness value; `/skills/calc`→200,
  `/skills/danger`→403, unknown→404; OpenAI response shape; streaming frames end with `[DONE]`.
- **Tolerant (real model, retried):** the agent calls the `multiply` tool and the answer
  contains `437`.

For `custom` (terminal): it returns a result but runs **no** tools (nothing extracted).

> The deterministic "a disabled skill drops the tool from the loop" guarantee is asserted in the
> runtime unit suite (`python/agent-runtime/tests/functional/test_frameworks.py`); the showcase
> asserts its public face (`/skills/danger` → 403), which doesn't depend on model output.
