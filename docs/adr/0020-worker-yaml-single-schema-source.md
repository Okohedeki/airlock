# worker.yaml has one schema source (JSON Schema); the CLI validates, the runtime trusts

> **Status (2026-06-04): Accepted.** Refines [ADR-0015](./0015-worker-yaml-single-manifest.md) (epic 07). Defines the validation boundary that epics 02/03/05/09/10/11/13 all extend.

`worker.yaml` is described by **one schema, in one place: a versioned, checked-in
`worker.schema.json` (JSON Schema)**. It is **owned and validated on the TS/CLI side
only** — `init`, `doctor`, and `migrate` validate against it. The **Python runtime
does not re-validate**: at boot it loads the YAML and reads values, trusting that
whatever reached it already passed the CLI. The **CLI is the validation gate.**

This refines [ADR-0015](./0015-worker-yaml-single-manifest.md), whose original
consequence said "a TS schema/validator (in the CLI) and a Python loader (in the
runtime) must stay in sync." Two hand-maintained schemas for one manifest — extended
by eight epics — will drift, and the failure is silent: `airlock doctor` greenlights a
manifest the runtime then rejects at boot or, worse, partially ignores. One schema
source removes the drift class entirely.

## Considered Options

- **Hand-maintained idiomatic schemas in each language + a consolidation-time
  consistency check (rejected).** Idiomatic on both sides, but the check is the only
  thing standing between the two definitions, and it runs late; drift is found at
  consolidation or runtime, not authoring time.
- **One JSON Schema, validated TS-side, runtime trusts (accepted).** A single file is
  the source of truth; the TS validator consumes it directly (or generates Zod from
  it); the runtime never holds a competing definition. Each epic that adds a block
  edits exactly one file, and consolidation diffs one file.

## Consequences

- **The CLI is the only validation gate**, so *every* path that produces or mutates a
  `worker.yaml` must route through the TS validator — including epic 07 **hot-reload**
  and any epic 11 **trigger** that writes config. A manifest that reaches the runtime
  by some other path is booted unvalidated by design; producers, not the runtime, own
  correctness.
- Each Wave-2 epic that adds a block (`controls`, `routing`, `io`, `triggers`, `auth`,
  …) adds it to the **one** `worker.schema.json`; the consolidation gate diffs a single
  file rather than reconciling two.
- The runtime stays lean — a YAML load plus key reads, no `jsonschema` dependency and
  no second schema to keep current.
- Trade-off accepted: the Python runtime cannot independently catch a malformed
  hand-edited manifest; that is the price of a single source of truth, and it is
  mitigated by routing all mutation through the CLI.
