# Epic 09 — Deploy, expose & fleet router

## Context
The brief's deploy story: **one command to ship** on your own hardware; run as a **stable internal
service**; **flip the same worker to a public URL** with identical controls, no rebuild
(internal = external). Today `airlock up` spawns `python3` directly and opens a Cloudflare tunnel;
ADR-0012 (Docker-first, one image + no-Node shim) is decided but unbuilt, and there is no router.
This epic delivers packaging + the exposure model + the shared fleet router that epics 08/12 reuse.

## Scope
- **One command to ship:** `airlock deploy worker.yaml` → live worker on the operator's hardware.
- **Internal service:** a stable internal interface other services/agents call.
- **Expose to the internet:** flip the same worker to a public URL, no rebuild.
- The **fleet router** component (front of the worker fleet).

## Dependencies
07 (worker.yaml). Provides sticky routing for 04; reused by 08 (canary) and 12 (sharding).

## Design (locked decisions baked in)
- **Packaging (delivers ADR-0012):** build the **`airlockhq/airlock` Docker image** (bakes the
  Python runtime + cloudflared; model always external per ADR-0008) and a **no-Node shim**
  (`curl | sh` / Homebrew) wrapping `docker run`. `up.ts` stops spawning `python3` directly;
  `airlock deploy worker.yaml` runs the container.
- **Interface (locked):** OpenAI-chat (`/v1/chat/completions`) + typed `/skills/<id>`. **Internal
  vs external = network binding + auth only** — same routes either way.
- **Internal addressing (locked):** the worker gets a **stable internal URL** (host:port), and
  airlock keeps a **local worker registry** (name → address) so other services/agents discover it.
- **Expose flip (locked):** `expose: internal | public` in `worker.yaml` + an **`airlock expose`**
  command that opens/closes the public Cloudflare tunnel live (named/durable tunnel machinery
  already exists in `tunnel.ts`); public exposure layers on auth (epic 10). No rebuild.
- **Fleet router (new):** sits in front of the worker fleet for version/variant routing + LB,
  reused by canary (08) and sharding (12), and provides **sticky routing** for resume/fork (04).
  **Control stays inside each worker** — the router routes between workers, it never proxies the
  loop opaquely.

## Key files
Dockerfile + image build + publish; the no-Node shim script; `up.ts`/`exec.ts`/`tunnel.ts`
rework; new `router/` (process or cloudflared-integrated); worker registry (state store, epic 04);
`worker.yaml` `expose` schema.

## Open questions
- Router as a separate process vs integrated with cloudflared/Workers; where it runs relative to
  the fleet.
- Internal addressing assumptions (bare host:port + registry vs mesh/DNS integration — registry
  chosen for v1, mesh as an adapter later).
- Shim distribution + image-tag/versioning story.

## Verification
- `airlock deploy worker.yaml` → a live internal endpoint, listed in the registry, reachable by
  another local service.
- `airlock expose` → the same worker on a public URL, same routes; `unexpose` closes it; no
  rebuild.
- With ≥2 replicas, the router load-balances and supports a version split (feeds epic 08).
