# airlock showcase — all 6 harnesses green (2026-06-12)

Every harness adapter driven by a **real local tool-calling model** (Qwen2.5-3B-Instruct
via llama-server, `--jinja --parallel 6`), one container each, behind airlock's runtime.
airlock extracts each framework's tools and drives the loop itself (OWN), so the full
control surface + skill ACLs apply uniformly. `custom` is Terminal (observe-only).

| Harness | Control mode | tool exec | skills ACL | response shape | streaming | real model loop |
|---|---|---|---|---|---|---|
| langgraph | OWN | ✅ | ✅ | ✅ | ✅ | ✅ |
| smolagents | OWN | ✅ | ✅ | ✅ | ✅ | ✅ |
| crewai | OWN | ✅ | ✅ | ✅ | ✅ | ✅ |
| openai-agents | OWN | ✅ | ✅ | ✅ | ✅ | ✅ |
| claude | OWN | ✅ | ✅ | ✅ | ✅ | ✅ |
| custom | Terminal | n/a (observe-only) | n/a | ✅ | ✅ | ✅ |

## Run output
```
test_showcase.py::TestOwnHarness::test_skill_danger_disabled[crewai] PASSED [ 43%]
test_showcase.py::TestOwnHarness::test_skill_danger_disabled[openai-agents] PASSED [ 46%]
test_showcase.py::TestOwnHarness::test_skill_danger_disabled[claude] PASSED [ 48%]
test_showcase.py::TestOwnHarness::test_skill_unknown_404[langgraph] PASSED [ 51%]
test_showcase.py::TestOwnHarness::test_skill_unknown_404[smolagents] PASSED [ 53%]
test_showcase.py::TestOwnHarness::test_skill_unknown_404[crewai] PASSED  [ 56%]
test_showcase.py::TestOwnHarness::test_skill_unknown_404[openai-agents] PASSED [ 58%]
test_showcase.py::TestOwnHarness::test_skill_unknown_404[claude] PASSED  [ 60%]
test_showcase.py::TestOwnHarness::test_response_shape[langgraph] PASSED  [ 63%]
test_showcase.py::TestOwnHarness::test_response_shape[smolagents] PASSED [ 65%]
test_showcase.py::TestOwnHarness::test_response_shape[crewai] PASSED     [ 68%]
test_showcase.py::TestOwnHarness::test_response_shape[openai-agents] PASSED [ 70%]
test_showcase.py::TestOwnHarness::test_response_shape[claude] PASSED     [ 73%]
test_showcase.py::TestOwnHarness::test_streaming_frames[langgraph] PASSED [ 75%]
test_showcase.py::TestOwnHarness::test_streaming_frames[smolagents] PASSED [ 78%]
test_showcase.py::TestOwnHarness::test_streaming_frames[crewai] PASSED   [ 80%]
test_showcase.py::TestOwnHarness::test_streaming_frames[openai-agents] PASSED [ 82%]
test_showcase.py::TestOwnHarness::test_streaming_frames[claude] PASSED   [ 85%]
test_showcase.py::TestOwnHarness::test_real_model_calls_multiply[langgraph] PASSED [ 87%]
test_showcase.py::TestOwnHarness::test_real_model_calls_multiply[smolagents] PASSED [ 90%]
test_showcase.py::TestOwnHarness::test_real_model_calls_multiply[crewai] PASSED [ 92%]
test_showcase.py::TestOwnHarness::test_real_model_calls_multiply[openai-agents] PASSED [ 95%]
test_showcase.py::TestOwnHarness::test_real_model_calls_multiply[claude] PASSED [ 97%]
test_showcase.py::test_custom_is_terminal PASSED                         [100%]
============================= 41 passed in 17.13s ==============================
```

Reproduce: start the model (see docs/showcase.md), then
`docker compose -f docker-compose.showcase.yml up -d --build` and
`docker compose -f docker-compose.showcase.yml run --rm harness-tests`.
