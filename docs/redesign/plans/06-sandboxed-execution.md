# Epic 06 — Sandboxed execution

## Context
Once airlock owns tool dispatch (epic 01), every tool and code call should run isolated so a
bad or hijacked tool can't touch the host — a property the brief calls out and a prerequisite for
running untrusted/agent-authored code safely. The runtime ships as a Docker image (epic 09), so
the sandbox lives inside that container.

## Scope
- Isolate **every tool and code call** from the host.

**Non-goals (deferred):** strong kernel-level isolation (gVisor / Firecracker microVM) and WASM
sandboxing — later phase.

## Dependencies
01 (engine owns tool dispatch). Runs inside the epic-09 Docker image.

## Design (locked: subprocess + limits for v1)
- Tool/code calls execute in a **separate subprocess** with **resource limits** (rlimits: CPU,
  memory, file descriptors; seccomp profile where available) and **no host network unless granted**
  in `worker.yaml`. Results are marshalled back to the engine over a pipe.
- `worker.yaml` declares per-tool grants: `sandbox: { network: false, fs: [paths], cpu_s, mem_mb }`.
- The engine routes tool dispatch through `engine/sandbox.py`, which spawns, supervises, enforces
  limits/timeouts, and captures the result (feeding epics 04/05).
- Stronger isolation (container-per-tool, microVM, WASM) is a documented later-phase upgrade behind
  the same dispatch seam.

## Key files
`engine/sandbox.py`; tool-dispatch path in the engine; `worker.yaml` `sandbox` schema; Dockerfile
(epic 09) ensures the subprocess primitives/seccomp are available.

## Open questions
- Default-deny vs default-allow for network/FS (lean default-deny, grant in manifest).
- Marshalling format + size limits for tool args/results across the process boundary.
- Behavior when a sandboxed tool exceeds limits (kill → counts as step failure → epic 03 fallback).

## Verification
- A tool attempting host FS or network access outside its grant is blocked; a normal granted tool
  runs and returns.
- A tool exceeding its CPU/mem/time limit is killed and surfaces as a step failure (triggering
  the epic-03 retry/fallback path).
