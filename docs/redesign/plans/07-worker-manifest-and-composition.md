# Epic 07 — Worker manifest & composition

## Context
The brief reframes the deliverable as **a worker, not an output** — "built from parts… one YAML
manifest… releasable in pieces." Today operational config is `.airlock/config.toml` with just
`[project]/[agent]/[tunnel]`. This epic defines `worker.yaml` as the single operational manifest
and the composition model the whole runtime reads. `airlock-config` stays the separate buyer-facing
descriptor (epic 00).

## Scope
- `worker.yaml` schema: the union consumed by all epics — **compose** (skills, MCP servers, tools,
  model bindings, harness) + controls (02) + routing/fallback (03) + io (13) + triggers (11) +
  expose (09) + tenancy/auth (10) + price table (05).
- **Releasable in pieces:** dev hot-reload; prod piece-changes go through canary/versioning (08).
- Migrate `.airlock/config.toml → worker.yaml`.

**Non-goals:** **hooks are out of v1 scope** — the harness/framework keeps control of hooks;
airlock does not implement a hook lifecycle.

## Dependencies
00 (config-file.ts superseded; migration scaffold). Feeds 01 (tools/model bindings), 02/03/05/13.

## Design (locked decisions baked in)
- **Compose model: skills = tools.** A skill IS a callable; tools imported from declared **MCP
  servers** are skills too. The airlock-config descriptor's skill JSON Schema is still used for
  typed I/O validation (epic 13) and `/skills/<id>` dispatch maps to the matching tool.
- **Model binding: multiple named bindings** — `models:` maps name → provider/endpoint/env-key; a
  `default` plus per-step overrides drive routing/fallback (epic 03).
- `worker.yaml` top-level blocks (illustrative):
  `worker` (name/version), `harness`, `models`, `skills`/`tools`, `mcp`, `controls`, `routing`,
  `fallback`, `io`, `state`/`sessions`/`cache`, `triggers`, `expose`, `auth`/`tenancy`,
  `pricing` (price table), `sandbox`.
- **Releasable in pieces (locked):** **dev hot-reload** — change `worker.yaml` and reload the
  running worker in place (safe vs in-flight runs: drain or version-pin running runs); **prod** —
  each piece-change mints a new worker version through the canary/rollback pipeline (epic 08).
- **Loaders:** a TS schema/validator in `packages/cli` (authoring, `init`, `doctor`, migration)
  and a Python loader in the runtime (boot the worker from `worker.yaml`). `init.ts`/`scan.ts`
  emit `worker.yaml`; `config-file.ts` is superseded.
- **Migration:** `airlock migrate` converts an existing `.airlock/config.toml` (project/agent/
  tunnel → worker/harness/expose; payment dropped).

## Key files
`worker.yaml` schema (TS in `packages/cli` + Python loader in `airlock_agent`); `init.ts`,
`scan.ts`, `migrate.ts`; runtime boot (`__main__.py`/`serve.py`) reads `worker.yaml`;
`config-file.ts` superseded.

## Open questions
- MCP server wiring details (stdio/HTTP transports; tool import + naming/namespacing).
- Hot-reload safety contract vs in-flight runs (drain vs pin vs reject-during-reload).
- How much of the old TOML to keep accepting during a deprecation window.

## Verification
- A worker boots entirely from `worker.yaml` (no `.airlock/config.toml`).
- Flipping a skill / swapping an MCP / changing a model binding in dev reloads in place.
- `airlock migrate` converts an existing `config.toml` to an equivalent `worker.yaml`.
- A `/skills/<id>` call dispatches the corresponding tool (skills = tools).

---

# Build-ready spec (frozen contract C2)

> Frozen 2026-06-04. **One schema source: a versioned `worker.schema.json`, validated TS-side
> only; the runtime trusts CLI-validated input.** See
> [ADR-0020](../../adr/0020-worker-yaml-single-schema-source.md). Every Wave-2 epic that adds a
> block edits **this one file** — the consolidation gate diffs it.

## Source of truth — `packages/cli/src/worker-schema/worker.schema.json`

JSON Schema (draft 2020-12), `$id` carries a schema version. The TS validator consumes it
directly (Ajv) or generates Zod from it — either way there is **no second, hand-maintained
schema**. The Python runtime never holds a competing definition.

### Top-level blocks (the union every epic extends — owners noted)

```yaml
worker:            # {name, version}                         — epic 07
harness:           # {kind, entrypoint, control_mode?}       — epic 07 / 01
models:            # name -> {provider, endpoint, env_key}   — epic 07; default + per-step (03)
skills:            # id -> tool ref  (skills = tools)         — epic 07
tools:             # name -> module:attr                      — epic 07
mcp:               # server -> {transport: stdio|http, ...}  — epic 07
controls:          # {max_steps, budget:{tokens,usd}, tool_gates[], approvals[]} — epic 02
routing:           # per-step model selection rules           — epic 03
fallback:          # model/tool backup chains                 — epic 03
io:                # {input_guards[], output:{schema,redact}} — epic 13
state:             # {backend, dsn?}  sessions: {ttl}  cache: {tools[]} — epic 04
triggers:          # {cron[], webhook[], event[]}             — epic 11
expose:            # internal | public  (+ auth ref)          — epic 09
auth:              # caller auth scheme                        — epic 10
tenancy:           # {claim->tenant map, limits}              — epic 10
pricing:           # price table                               — epic 05
sandbox:           # {network, fs, limits}                     — epic 06
variants:          # capability/cost/latency shards            — epic 12
```

Each block is **optional**; a minimal worker is `worker` + `harness` (+ `models`). Wave-2 epics
fill in their block's sub-schema in the *same* file.

## The validation boundary (C2)

- **TS / CLI is the only gate.** `init.ts` / `scan.ts` emit `worker.yaml`; `doctor` and `migrate`
  validate against `worker.schema.json`. `config-file.ts` is **superseded** (kept only to read
  legacy TOML during the deprecation window for `migrate`).
- **Python runtime trusts.** `airlock_agent/manifest.py` (new) = `yaml.safe_load` + typed
  accessors (`worker_name()`, `harness()`, `models()`, `skills()`, …). **No `jsonschema`
  dependency, no re-validation.** `config.py` (`read_agent_config`) is replaced by these accessors;
  `__main__.py`/`serve.py` boot from `manifest.py` instead of `.airlock/config.toml`.
- **Every producer routes through the validator.** Dev **hot-reload** (below) and any epic-11
  **trigger that writes config** call the TS validator before the runtime re-reads — a manifest
  reaching the runtime by any other path is booted unvalidated *by design*.

## Hot-reload safety contract (resolves open question)

`worker.yaml` change in dev → validate (TS) → signal runtime to reload. In-flight runs are
**version-pinned**: a running run keeps the manifest snapshot it started with; the new manifest
applies to runs started after the swap. No drain stall, no mid-run config flip. (Prod piece-changes
mint a new version through canary/rollback — epic 08.)

## MCP wiring (resolves open question)
`mcp:` declares servers by transport (`stdio` | `http`). On boot, the runtime imports each server's
tools and namespaces them `&lt;server&gt;.&lt;tool&gt;` into the tool set, so they flatten to skills like
any other tool. Naming collisions are a `doctor` validation error (TS side).

## File-by-file
- **new** `packages/cli/src/worker-schema/worker.schema.json` (+ `validate.ts` wrapper).
- **new** `python/agent-runtime/src/airlock_agent/manifest.py` (load + accessors; trusts).
- **edit** `migrate.ts` — fill the real mapping (epic 00 stub → full schema); drop payment.
- **edit** `init.ts`, `scan.ts` — emit `worker.yaml`.
- **edit** `__main__.py`, `serve.py` — boot from `manifest.py`; remove `config.py` TOML read.
- **supersede** `config-file.ts` (legacy-read only), `config.py`.

## Verification → test layers
- **L3 (full-CLI):** `airlock doctor` rejects an invalid `worker.yaml`; accepts a valid one.
  `airlock migrate` turns a sample `config.toml` into a schema-valid `worker.yaml`.
- **L4 (hermetic):** runtime boots a worker entirely from `worker.yaml` (no TOML present); a
  `/skills/<id>` call dispatches the mapped tool. Hot-reload: change a model binding mid-idle →
  next run uses it; a run in flight keeps its pinned manifest.
- **L1:** schema round-trips (every block parses); MCP namespacing + collision error.
