# worker.yaml is the single operational manifest

> **Status (2026-06-03): Accepted.** Redesign [epic 07](../redesign/plans/07-worker-manifest-and-composition.md) (with migration scaffolded in [epic 00](../redesign/plans/00-foundations-strip-crypto-config-reset.md)).

A deployed Worker is described by one file, **`worker.yaml`** — the union of every
operational concern: composition (skills, MCP, tools, model bindings, harness),
controls, routing/fallback, the I/O contract, state/sessions/cache, triggers,
expose, auth/tenancy, the price table, and sandbox grants. It replaces
`.airlock/config.toml`. An `airlock migrate` command converts the old TOML.

In the same move, **`airlock-config` is narrowed to the buyer-facing descriptor** of
the Worker — what skills it offers and their typed I/O schemas — validated and
served at `/.well-known`. It is no longer an operational config; the manifest and
the descriptor are two different artifacts with two different audiences (the
Operator vs. the Caller).

## Considered Options

- **Keep `.airlock/config.toml` and grow it (rejected).** Familiar, but TOML's
  ergonomics degrade badly for the deeply nested, list-heavy structures the new
  blocks need (controls, routing, variants, io rules), and "config" conflated the
  operator manifest with the buyer contract.
- **One `worker.yaml` manifest + descriptor-only airlock-config (accepted).** A
  single source of truth for operations, YAML for nested structure, and a clean
  split between the operational manifest and the public contract.

## Consequences

- The schema has **one source of truth** — a checked-in `worker.schema.json`
  validated on the TS/CLI side; the Python runtime loads and trusts it rather than
  re-validating. See [ADR-0020](./0020-worker-yaml-single-schema-source.md).
- The Worker becomes the unit that is composed, released in pieces, and versioned
  ([ADR-0017](./0017-fleet-router.md), epic 08).
- "Skills flatten to tools," and the airlock-config skill schema is reused for the
  typed I/O validation in [epic 13](../redesign/plans/13-contract-shaping-input-output.md).
