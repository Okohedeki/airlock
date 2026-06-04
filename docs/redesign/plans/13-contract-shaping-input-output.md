# Epic 13 — Contract shaping (input / output)

## Context
Downstream code can only trust a worker if its inputs are guarded and its outputs are shaped. The
brief: **controlled input** (reject junk/injection before the loop spends a token) and
**controlled output** (enforce schema/format/redaction on every call). This is also where the
typed `/skills/<id>` endpoints + airlock-config descriptor integration land (relocated from
epic 00). Since **skills = tools** (epic 07), a `/skills/<id>` call dispatches the matching tool
through the engine.

## Scope
- **Controlled input:** validate + guard inbound requests pre-loop.
- **Controlled output:** enforce schema, format, and redaction on every response.
- Typed `/skills/<id>` endpoints backed by the airlock-config descriptor's skill schemas.

## Dependencies
07 (manifest + skills=tools), 01 (engine dispatch), 00 (airlock-config kept for schema/validation).

## Design (locked decisions baked in)
- **Input (locked):** validate the request body against the **skill JSON Schema** from the
  airlock-config descriptor (for `/skills/<id>`) **plus declarative pattern rules** in
  `worker.yaml` `io.input:` — size/shape limits + a denylist/regex for known injection markers.
  Reject **before any model call** with airlock-config's status vocabulary
  (`SCHEMA_INVALID` / `MALFORMED_INPUT` / `MISSING_INPUT`). (Model-based/heuristic injection
  scoring is a documented later-phase add.)
- **Output (locked):** enforce the output schema → on violation, **repair once** (re-ask the model
  to conform) → apply **redaction rules** (PII/secret classes/patterns) → if still non-conforming,
  **reject** with a clear error. Configured in `worker.yaml` `io.output:`.
- **Typed `/skills/<id>`:** a Python skill-schema loader reads the descriptor; routes in
  `surface.py` validate input (above), dispatch the matching tool through the engine (epic 01),
  and shape the output (above). Redaction here also governs what step traces persist (epic 05).

## Key files
New `io/` (input guard + output enforce + redaction); Python skill-schema loader (reads the
airlock-config descriptor); `/skills/<id>` routes in `surface.py`; `worker.yaml` `io` schema;
shared redaction used by epic 05 trace persistence.

## Open questions
- Injection denylist/regex starter set + how operators extend it.
- "Repair once" prompt strategy + whether repair counts against the budget (epic 02).
- Redaction class taxonomy (reuse airlock-config permissions `data_classes`?).

## Verification
- Invalid / injection-marked input is rejected **before any model call** with the right status.
- A non-conforming model output is repaired once; if still bad, redacted-then-rejected per rules.
- A `/skills/<id>` call validates against the descriptor schema and dispatches the matching tool.
