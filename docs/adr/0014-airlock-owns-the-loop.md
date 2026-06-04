# Airlock owns the loop

> **Status (2026-06-03): Accepted.** The keystone of the redesign ([epic 01](../redesign/plans/01-airlock-loop-engine.md)). Supersedes [ADR-0007](./0007-harness-adapter-interface.md).

airlock becomes an **in-the-loop agent runtime**: the **Loop Engine** owns the
agent loop — it assembles the prompt, makes the model call, parses the action,
dispatches the tool, records a `StepEvent`, consults any `ControlSignal`, and
repeats. The Harness no longer runs its own opaque native loop; instead each
Harness (LangGraph, CrewAI, smolagents, OpenAI Agents, Claude SDK, custom)
contributes **tools, a planner, and prompt assembly**, and airlock drives them.

This inverts [ADR-0007](./0007-harness-adapter-interface.md), where the adapter ran
the framework's full loop server-side (`run(messages) → result`) and airlock saw
only the final answer. That contract made the whole differentiator impossible: only
LangGraph and the Claude SDK exposed step seams; smolagents/CrewAI/OpenAI Agents
were black boxes, and there was no place to put step control, checkpointing, or
intervention.

## Why this is the keystone

Every downstream control-the-loop feature depends on owning the loop: loop guards
and mid-run intervention ([epic 02](../redesign/plans/02-loop-control-and-guards.md)),
per-step model routing and fallback ([epic 03](../redesign/plans/03-midrun-routing-and-fallback.md)),
checkpoint/resume/replay/fork ([epic 04](../redesign/plans/04-state-checkpoint-resume-replay-fork.md)),
step observability ([epic 05](../redesign/plans/05-step-observability.md)),
sandboxed tool execution ([epic 06](../redesign/plans/06-sandboxed-execution.md)),
and contract shaping ([epic 13](../redesign/plans/13-contract-shaping-input-output.md)).
A front-of-agent gateway structurally cannot offer these, because it never sees
inside the loop.

## Considered Options

- **Keep the adapter-runs-native-loop contract (ADR-0007), bolt control on in
  front (rejected).** Lowest effort and preserves each framework's native
  behavior, but airlock stays outside the loop — no per-step control, no
  mid-run intervention, no real checkpoint/replay. This is the exact limitation the
  redesign exists to remove.
- **Airlock owns the loop; harnesses contribute tools/planner/prompt (accepted).**
  Uniform `StepEvent`/`ControlSignal` seam across all harnesses; the cost is a
  per-harness binding rewrite and extracting tools/planner from the more opaque
  frameworks.

## Consequences

- **Hooks stay with the harness** in v1 — airlock does not implement its own hook
  lifecycle.
- Opaque frameworks (smolagents/CrewAI/OpenAI Agents) need wrapping to expose their
  tool set and planner; the exact extraction strategy per framework is an open
  question in epic 01.
- airlock now *makes the model calls itself* — but the model stays external
  ([ADR-0019](./0019-inference-stays-external.md)).

## Consequences — loop ownership is feature-derived, not uniform (2026-06-04)

"Owns the loop" is not a single binary that holds equally across the six harnesses.
What actually matters is whether a given downstream feature works by **owning** the
loop (intercepting *between* model-call and tool-dispatch) or by **calling**/wrapping
(intercepting at the tool-dispatch boundary only). This splits the control surface
into two columns:

- **Tool-centric — works by calling, on every harness:** tool gating by argument
  (02), approval hold on send/pay/write tools (02), tool-failure fallback (03),
  tool-result cache/reuse (04), sandboxed tool execution (06).
- **Model/state — requires owning, only where airlock drives the model calls:**
  mid-run model routing (03), model-failure fallback (03), mid-run token/$ budget
  stop (02), checkpoint/resume + replay/fork (04), per-step model cost + live
  reasoning stream (05).

Per-harness availability is therefore a **matrix lookup**: native-seam harnesses
(LangGraph, Claude SDK) get both columns; opaque harnesses (smolagents, CrewAI,
OpenAI Agents) always get the tool-centric column and get the model/state column only
where their defs extract cleanly — otherwise that harness **degrades gracefully**
(the model/state features are simply unavailable there and documented as such; full
parity across all harnesses is *not* a hard requirement). Downstream-epic verification
tests each feature only on harnesses the matrix says support it.

The moat is unaffected: a front-of-agent gateway can offer **neither** column, because
it never sees inside the loop at all. Ownership is full on native-seam harnesses and
tool-gated on opaque ones — strictly more than a gateway can do, just not uniform.
