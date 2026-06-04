# Inference stays external; airlock orchestrates the calls

> **Status (2026-06-03): Accepted.** Carries forward the invariant of [ADR-0008](./0008-airlock-never-hosts-inference.md) (now superseded) under the in-the-loop runtime framing of [ADR-0014](./0014-airlock-owns-the-loop.md). Restates the model-external half of [ADR-0012](./0012-docker-first-runtime-model-external.md).

Owning the loop ([ADR-0014](./0014-airlock-owns-the-loop.md)) means the Loop Engine
now **makes the model calls itself**. This ADR records that doing so does **not** make
airlock an inference host: the model is always an external **OpenAI-compatible
endpoint** the Operator supplies (`OPENAI_API_BASE` / `OPENAI_API_KEY`). The
inference runs on the Operator's own machine or chosen provider — self-hosted
(vLLM/llama.cpp on their GPU, host-native `llama-server` on a Mac reached via
`host.docker.internal`) or a bring-your-own-key provider (Groq/Together/Fireworks).
**airlock never runs GPUs, never bundles a model, and never custodies model keys.**

The distinction is deliberate: *orchestrating* the calls (which step, which model,
with what budget) is the product; *running* the inference (GPUs, scaling, cost,
abuse, key custody) stays with the Operator. ADR-0008's reasoning held — the moment
we ran models, those costs would fall on us — and that reasoning survives the
pivot; only the framing changed (airlock used to forward to the model; now it calls
the model directly, still external).

## Considered Options

- **airlock hosts/curates inference (rejected for the open core).** Best UX for
  non-technical operators, but makes us an inference platform — GPU ops, scaling,
  abuse, key custody. Explicitly a possible future, separate, paid product; not the
  open core, not v1.
- **Model is always an external OpenAI-compatible endpoint (accepted).** One uniform
  contract for hosted and local models, inference cost/ops stay with the Operator,
  and the per-step routing in [epic 03](../redesign/plans/03-midrun-routing-and-fallback.md)
  simply points at named external bindings.

## Consequences

- Per-step model routing and fallback select among **external** model bindings.
- Inference speed (which compounds across loop steps) is the Operator's lever via
  their provider/hardware choice, not something airlock solves by hosting.
