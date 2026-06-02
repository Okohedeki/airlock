# Docker-first runtime; the model is always external

A new user on a fresh machine must be able to install airlock and go live. The
blocker is the unmanaged **Node↔Python boundary**: the CLI is Node, the runtime
is Python (`airlock-agent`, FastAPI/uvicorn), and the host must satisfy *both*
toolchains. Worse, the Python requirement is version-sensitive — `airlock-agent`
needs ≥3.9, the `crypto` extra needs ≥3.10, and the eth/x402 stack is brittle
across patch levels — yet nothing checks, bootstraps, or pins it.
`airlock up` resolves `python3` and spawns it with **no existence, version, or
importability check** (`packages/cli/src/commands/up.ts:109,238`), so missing or
wrong Python, an un-installed `airlock_agent`, a bad entrypoint, a missing model
key, and a busy port **all collapse into one opaque `did not become healthy
within 120s` timeout**. This is the first thing a stranger hits, and it is the
single largest reason the earlier "ready for v1" call was wrong.

**Decision: ship airlock as one Docker image, and never run inference inside it.**

The host artifact is a single image (`airlockhq/airlock`, `python:3.11-slim`)
that bakes the CLI logic, the payment middleware, the cloudflared connector, and
the Python runtime — including `airlock-crypto` — via `pip` at build time. A thin
**no-Node `airlock` shim** (`curl | sh` / Homebrew) wraps `docker run` with a
documented mount contract (`.airlock/` config, `~/.airlock/wallet` keystore at
`0600`, an optional local-model dir). Docker becomes the **single** host
prerequisite; the shim *replaces* the Node dependency rather than adding to it.
Pinning Python in the image makes "even the version matters" and the original
`airlock-crypto` install pain both disappear, and lets `doctor` run its
pre-flight **in the same environment** that `up` will use — so importability and
port checks are finally trustworthy, and the opaque 120s timeout is replaced by
named, fail-fast errors.

The image **never does inference** ([ADR-0008](./0008-airlock-never-hosts-inference.md)
— airlock doesn't own the model). There is one uniform contract: airlock is given
an **OpenAI-compatible model URL**. Hosted models are that URL directly; local
models run as a server *outside* the container — host-native `llama-server` on a
Mac (Docker's Linux VM cannot reach Apple **Metal**, so in-container local
inference would be CPU-only), or GPU-passthrough on Linux — reached via
`host.docker.internal`. The local case ships as an **optional** `docker-compose`
sidecar recipe; airlock pulls no model by default. This supports hosted and local
publishers with a single code path and keeps the Mac-Metal performance story
intact.

This continues the consolidation begun when Fly was removed
([ADR-0003](./0003-two-targets-at-v1.md) is now historical): the runtime is **one
container**, not a matrix of deploy targets. The full new-user review that drove
this decision lives in the v1-readiness review.

## Considered Options

- **Native + `uv` auto-bootstrap** — keep the npm CLI; use Astral `uv` to install
  a sealed Python 3.11 + runtime under `~/.airlock`. One command, no Docker,
  keeps local-model file access trivial. *Rejected as the v1 primary* because it
  still leaves two host toolchains (Node + the bootstrapped Python), still owns a
  bespoke bootstrap to maintain, and doesn't pin the *whole* environment the way
  an image does. Retained as a possible v1.1 alternative path, not v1.
- **Container-first, but bundle the model in the image** — simplest "it just
  runs" story, but it traps local inference CPU-only on Macs (no Metal in the
  Docker VM), bloats the default image, and pulls a model nobody asked for.
  Rejected; inference stays external.
- **Tiered (native default + published image)** — robust and matches how mature
  CLIs ship, but it's two install paths to build, document, and keep in sync for
  a v1. Deferred: ship the image for v1, revisit a native path later.
- **Keep the npm CLI and shell out to `docker run`** — would mean Node *and*
  Docker as prerequisites, the opposite of the goal. Rejected in favor of the
  no-Node shim.

## Costs accepted

airlock now **owns an image**: build, host (GHCR/Docker Hub), tag per release, and
**patch the base for CVEs on a cadence** (a new SecOps responsibility). The shim
must be built and distributed cross-platform. `host.docker.internal` needs
`--add-host=host.docker.internal:host-gateway` on Linux. The wallet key crosses
the host↔container boundary via the mount (same machine — acceptable, documented).
cloudflared-in-container is a net win: outbound-only, no inbound port mapping.
