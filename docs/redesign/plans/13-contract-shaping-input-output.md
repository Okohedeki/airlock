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

---

# Build-ready spec (frozen contracts)

> Frozen 2026-06-04. Contract shaping lives at the **surface boundary**, not inside the loop, so it
> is **harness-agnostic** (C1): input guarding fires pre-loop on every binding, output enforcement
> fires on the final answer on every binding — `OWN` and `WRAP` alike. The `io/` **redaction**
> submodule is **shared with epic 05** (C3) — its trace store imports it; do not fork redaction. The
> `io` block extends the **one** `worker.schema.json` (C2); skills = tools (C2) so `/skills/<id>`
> dispatches the matching engine tool.

## The `io/` module — `airlock_agent/io/` (new)

Three submodules, all pure functions over plain dicts (no engine import — they bracket the loop):

```python
# io/guard.py — runs BEFORE any model call (pre-loop).
@dataclass
class GuardResult:
    ok: bool
    status: str | None = None         # SCHEMA_INVALID | MALFORMED_INPUT | MISSING_INPUT | INJECTION_BLOCKED
    detail: str | None = None
    matched_rule: str | None = None

def guard_input(body: dict, *, schema: dict | None, guards: list[dict]) -> GuardResult:
    # 1. shape/size limits (max_bytes, max_messages, required fields) -> MALFORMED_INPUT/MISSING_INPUT
    # 2. JSON-Schema validate against `schema` (skill descriptor schema) -> SCHEMA_INVALID
    # 3. injection denylist/regex scan over message text -> INJECTION_BLOCKED
    # Returns on FIRST failure. No model tokens spent yet.

# io/enforce.py — runs on the FINAL answer (and per-step redaction is reused by 05).
@dataclass
class EnforceResult:
    ok: bool
    content: Any                       # conformed + redacted payload (best effort even on reject)
    status: str | None = None          # OUTPUT_SCHEMA_INVALID | OUTPUT_FORMAT_INVALID
    repaired: bool = False             # a repair pass was spent (counts vs epic-02 budget)

def enforce_output(content: Any, *, schema: dict | None, fmt: str | None,
                   redact: list[dict], repair) -> EnforceResult:
    # validate schema/format -> if bad, call `repair(content, schema, fmt)` ONCE ->
    # re-validate -> redact(content) always -> if still bad, reject (redacted) with status.

# io/redact.py — SHARED with epic 05 (C3). Pure, deterministic, no model.
def redact(value: Any, rules: list[RedactRule]) -> Any: ...   # walk + mask by class/pattern
def default_rules() -> list[RedactRule]: ...                  # built-in PII/secret classes
```

**Injection starter set + operator extension (resolves open question).** `io/guard.py` ships a
built-in denylist of regex markers (case-insensitive): `ignore (all )?previous instructions`,
`disregard (the )?(above|system)`, `system prompt`, `you are now`, `developer mode`,
`reveal your (instructions|prompt)`, `<\|im_start\|>` / role-injection control tokens, and base64
blobs over a length threshold. Operators **extend, never replace** via `worker.yaml`
`io.input_guards[].injection: { extend: [regex…], replace: false }` — the built-in set always
runs unless an operator explicitly sets `replace: true`. (Model/heuristic scoring stays a later
phase, per the locked design.)

**Repair-once strategy + budget (resolves open question).** `repair` re-asks the *same* model
binding with a terse correction system message — the schema/format + the validator's error path +
"return ONLY a value conforming to this schema" — and the prior non-conforming output. It runs
**at most once**. **The repair call DOES count against the epic-02 token/$ budget** (recommended):
it is a real model call routed through the engine, so it must debit the same budget the loop spends
or budget enforcement has a hole. If the repair pass would exceed budget, skip repair and go
straight to redact-then-reject.

**Redaction taxonomy (resolves open question, flagged).** Reuse the airlock-config permissions
`data_classes` as the class vocabulary when the descriptor declares them (read via `wellknown.py`,
below) — a redact rule references a class (e.g. `email`, `ssn`, `api_key`) or a raw `pattern`.
**OPEN:** confirm `data_classes` exists in the airlock-config permissions block; if it does not, fall
back to the built-in class set in `default_rules()` and treat `worker.yaml` `io.output.redact[]` as
the authoritative source. Either way redaction is deterministic and model-free so epic 05's trace
store can call it inline.

## Typed `/skills/<id>` endpoints — `surface.py` + `io/skill_schema.py` (new)

```python
# io/skill_schema.py — Python skill-schema loader. Reads the airlock-config descriptor
# via wellknown.read_contract_metadata (which already surfaces `skills`), then resolves
# each skill's typed input/output JSON Schema.
def load_skill_schemas(dist_dir: str = "dist") -> dict[str, dict]:
    md = read_contract_metadata(dist_dir)            # {agent, category, region, skills}
    # -> { skill_id: {"input": <jsonschema>, "output": <jsonschema>, "format": ...} }
    # No descriptor (None) -> {} ; /skills/<id> then 404s. Cached at app build.
```

`surface.py` gains a typed route family. Each `/skills/<id>` call:

1. **guard_input** the body against the descriptor's **input** schema + `worker.yaml`
   `io.input_guards[]` → reject pre-loop with the right status (`SCHEMA_INVALID` /
   `MALFORMED_INPUT` / `MISSING_INPUT` / `INJECTION_BLOCKED`) **before** acquiring a model turn.
2. run the loop (`run_loop`, epic 01) with the matching tool as the dispatch target — **skills =
   tools (C2)**, so `<id>` resolves to the engine tool of the same name.
3. **enforce_output** on the result against the descriptor's **output** schema/format +
   `io.output.redact[]` → repair-once → redact → reject if still bad.

Wraps the **same** `BoundedGate` admission + `run_in_threadpool` model as `/v1/chat/completions`;
the chat route also runs `enforce_output` on its final content (and `guard_input` on inbound
messages) so shaping is universal, not skills-only.

## The `io` block in `worker.schema.json` (C2)

Extends the **one** schema file (no second source). Sub-schema for the `io` block:

```yaml
io:
  input_guards:           # array of declarative pre-loop rules
    - max_bytes: 32768
      max_messages: 50
      required: [messages]
      injection: { extend: ["my-org-marker.*"], replace: false }
  output:
    schema: { $ref: "…" }        # JSON Schema the final answer must conform to (optional)
    format: json | text | markdown
    redact:                       # ordered rules; class reuses airlock-config data_classes
      - { class: email }
      - { pattern: "sk-[A-Za-z0-9]{20,}", replacement: "[REDACTED_KEY]" }
```

Per-skill typed I/O comes from the **descriptor** (authoritative for `/skills/<id>`); the
`worker.yaml` `io` block carries worker-wide guards + the redaction rules epic 05 also honors.

## File-by-file

- **new** `airlock_agent/io/guard.py` — `guard_input` + injection starter set + operator extend.
- **new** `airlock_agent/io/enforce.py` — `enforce_output` (schema/format → repair-once → reject).
- **new** `airlock_agent/io/redact.py` — `redact` + `default_rules`; **exported for epic 05** (C3)
  via `io/__init__.py` (`from .redact import redact, default_rules, RedactRule`).
- **new** `airlock_agent/io/skill_schema.py` — descriptor-backed loader reading `wellknown.py`.
- **edit** `surface.py` — typed `/skills/<id>` route family (guard → `run_loop` dispatch → enforce);
  run `guard_input`/`enforce_output` on the chat route too; load skill schemas at `create_app`.
- **edit** `wellknown.py` — `read_contract_metadata` already returns `skills`; ensure the per-skill
  `input`/`output` schema fields are surfaced (extend the projected key set if the descriptor nests
  them) so `skill_schema.py` need not re-parse the YAML.
- **edit** `packages/cli/src/worker-schema/worker.schema.json` — add the `io` sub-schema above.

## Verification → test layers (`docs/testing-e2e.md`)
- **L1:** `guard_input` returns each status for the matching defect (oversize → `MALFORMED_INPUT`,
  schema miss → `SCHEMA_INVALID`, marker hit → `INJECTION_BLOCKED`) with **zero** model calls (assert
  the stub model is never invoked). `enforce_output`: conforming passes; one non-conforming output is
  repaired once (repair counted) then redacted-then-rejected. `redact` masks by class + pattern.
- **L2 (in-process ASGI, stub harness):** `/skills/<id>` validates a bad body against the descriptor
  schema and 4xx's **before** the loop runs; a good body dispatches the **matching tool** and the
  response conforms to the output schema. Run on **both** an `OWN` and a `WRAP` binding — shaping is
  harness-agnostic (C1), so assertions are identical.
- **L4 (hermetic):** epic-05 trace store imports `io.redact` and persists redacted step I/O — same
  masking as the surface (C3 shared-module check).
