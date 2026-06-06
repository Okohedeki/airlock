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

---

# Build-ready spec (frozen contracts)

> Frozen 2026-06-04. **Sandboxing is a tool-dispatch concern, not a harness concern** — it wraps
> the single dispatch shim that both `OWN` and `WRAP` bindings route through (C1), so it works on
> **all** harnesses. v1 = subprocess + rlimits; default-DENY network. This follows directly from
> [ADR-0014 §"loop ownership is feature-derived"](../../adr/0014-airlock-owns-the-loop.md) (tool
> dispatch is the universal seam); sandboxing needs no separate cross-epic ADR. Consumes C1
> (`StepEvent`/`control_mode`), C2 (`worker.schema.json`), C3 (cache-before-spawn ordering);
> produces `status=error` step failures that feed epic-03 retry/fallback.

## Where it sits (the C1 mapping — authoritative)

Both modes funnel tool execution through **one** callable, `dispatch(tool, args, grants)`
(epic-01 `loop.py`): `OWN` calls it after parsing a `ToolCall`; `WRAP` hands it to
`binding.run_wrapped(messages, dispatch)`. Sandboxing **decorates that one callable** —
`dispatch = sandboxed(raw_dispatch)` — so isolation fires identically on every harness without
per-binding code. Tool-result cache (C3) wraps **outside** sandbox; a cache hit short-circuits
**before** any subprocess is spawned.

```
cache.check ──hit──▶ return (no spawn)
     │ miss
     ▼
sandbox.dispatch_sandboxed(tool, args, grants) ─▶ subprocess(rlimits, net/fs policy) ─▶ result
     │ exceeds limits / policy violation
     ▼  kill -9 + StepEvent(status=error, error="sandbox: <reason>") ─▶ epic-03 fallback
```

## Frozen interface — `airlock_agent/engine/sandbox.py`

```python
from dataclasses import dataclass, field

@dataclass(frozen=True)
class SandboxGrants:           # resolved per-tool from worker.yaml (see schema below)
    network: bool = False                       # default-DENY
    fs_read:  tuple[str, ...] = ()              # absolute paths/globs granted read
    fs_write: tuple[str, ...] = ()              # absolute paths/globs granted write
    cpu_s:    float = 5.0                       # SIGXCPU rlimit (RLIMIT_CPU)
    mem_mb:   int = 512                         # RLIMIT_AS
    max_fds:  int = 64                          # RLIMIT_NOFILE
    wall_s:   float = 10.0                      # supervisor wall-clock kill (> cpu_s)
    max_io_bytes: int = 4 * 1024 * 1024         # marshalling cap before temp-file handoff

class SandboxViolation(Exception):              # reason carried into StepEvent.error
    """raised in-parent when the child is killed or breaches the net/fs policy."""

def dispatch_sandboxed(tool, args: dict, grants: SandboxGrants) -> Any:
    """Run `tool(**args)` in a forked subprocess under rlimits + net/fs policy.
    Returns the tool result on success. On limit-breach or policy violation, kills the
    child (SIGKILL) and raises SandboxViolation(reason). Non-serializable args/results
    raise SandboxViolation('unmarshallable')."""
```

`loop.py` maps `SandboxViolation` → `StepEvent(type=TOOL_RESULT, status=StepStatus.ERROR,
tool=name, error="sandbox: <reason>")` (C1). That `status=error` is exactly what epic-03's
retry/fallback consumes — sandboxing needs no new failure channel.

## Marshalling format + size limits (resolves open question)

- **Args in / result out = JSON over a pipe.** Child reads args JSON from fd, writes result JSON
  to fd. JSON-only forces a clean serializable boundary (no pickle → no code-exec on unmarshal).
- **Large-blob fallback:** if either side exceeds `max_io_bytes`, write to a temp file inside a
  granted `fs_write` path and pass a `{"__blob__": "<path>"}` envelope; parent reads + unlinks it.
- **Non-serializable** args/results (sockets, live handles, lambdas) → `SandboxViolation
  ('unmarshallable')`, surfaced as `status=error`. No silent coercion.

## The `sandbox` block — added to `worker.schema.json` (C2)

One schema, TS-validated (C2). Lives under each tool entry; a top-level `sandbox.defaults`
supplies the fallback grant. Default-DENY: a tool with no `sandbox` block gets `network:false`,
empty `fs_*`, and `defaults` limits.

```jsonc
"sandbox": {
  "type": "object",
  "properties": {
    "defaults":  { "$ref": "#/$defs/sandboxGrant" },     // applied to every tool
    "perTool":   {                                        // overrides by tool name
      "type": "object",
      "additionalProperties": { "$ref": "#/$defs/sandboxGrant" }
    }
  }
}
// $defs/sandboxGrant:
// { network:bool(default false), fsRead:string[], fsWrite:string[],
//   cpuS:number, memMb:int, maxFds:int, wallS:number, maxIoBytes:int }
```

Resolution order: `perTool[name]` ⟶ `defaults` ⟶ built-in `SandboxGrants()` (deny + 5s/512MB).

## File-by-file
- **new** `engine/sandbox.py` — `SandboxGrants`, `SandboxViolation`, `dispatch_sandboxed`. Sets
  `resource.setrlimit` (RLIMIT_CPU/AS/NOFILE) in the child pre-exec; applies a seccomp profile +
  network namespace / socket-block when `network=false`; chroot-or-bind the granted `fs_*` paths;
  supervisor thread enforces `wall_s` and SIGKILLs.
- **edit** `engine/loop.py` (C1) — wrap the dispatch shim once: `dispatch = make_sandboxed
  (raw_dispatch, grants_for(tool))`; this is the SAME shim `OWN` calls and `WRAP` receives via
  `run_wrapped`. Map `SandboxViolation` → `StepEvent(status=ERROR)`. Cache lookup (C3) stays
  **outside** the sandboxed dispatch so a hit never spawns a child.
- **edit** `loader.py` (C1) — resolve `SandboxGrants` per tool from the `worker.yaml` `sandbox`
  block; hand them to the dispatch wrapper.
- **schema** — `sandbox` block + `$defs/sandboxGrant` in `worker.schema.json` (C2).
- **Dockerfile note (epic 09, C4):** the runtime image must ship the subprocess-isolation
  primitives the sandbox relies on — a kernel with user namespaces + seccomp-bpf, `libseccomp`,
  and the ability to create a no-route network namespace (CAP_SYS_ADMIN or rootless equivalent).
  Document the degraded fallback (rlimits-only, no seccomp/netns) for hosts that lack them.

## Open questions — resolved
- *Default-deny vs default-allow:* **default-DENY network + explicit FS grants.** A tool gets the
  host only where `worker.yaml` says so; absent config = fully sandboxed.
- *Marshalling format/size:* **JSON + `max_io_bytes` cap, temp-file handoff for large blobs,
  reject non-serializable** (above).
- *Limit-breach behavior:* **SIGKILL the child, raise `SandboxViolation`, surface as
  `StepEvent(status=error)` → epic-03 fallback** (above).

## Verification → test layers (`docs/testing-e2e.md`)
- **L1:** a tool reading `/etc/passwd` or opening a socket with no grant → `SandboxViolation`
  ("fs"/"net"); a tool granted `fs_read:["/data"]` + `network:true` runs and returns; a tool that
  `while True: pass` (cpu) / allocs 2 GB (mem) / `sleep(60)` (wall) is SIGKILLed and surfaces
  `StepEvent(status=error)`; non-serializable result → `unmarshallable`; cache hit returns **with
  no subprocess spawned** (assert spawn count == 0).
- **L2 — prove the C1 claim on both modes:** run the same offending + granted tools through an
  **`OWN` harness (LangGraph stub)** and a **`WRAP` harness (smolagents stub)**; assert identical
  block/kill/`status=error` behavior on both — sandboxing is harness-independent because it sits at
  dispatch. Assert the killed step triggers epic-03 retry/fallback.
- **L5 (manual):** a real CrewAI (`WRAP`) and Claude SDK (`OWN`) run with a deliberately abusive
  tool, inside the epic-09 image, confirming seccomp/netns enforcement (not just rlimits).
