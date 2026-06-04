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
