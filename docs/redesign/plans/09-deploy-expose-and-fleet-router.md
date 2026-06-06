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

---

# Build-ready spec (frozen contract C4)

> Frozen 2026-06-04. **The router is one ordered pipeline of pluggable stages; stickiness wins
> over canary.** See [ADR-0017 §"one ordered routing pipeline"](../../adr/0017-fleet-router.md).
> Epics 08/10/11/12 implement *their stage*, not their own router.

## Frozen router pipeline — `router/pipeline.ts` (in `packages/cli` or a sibling `router/` pkg)

```ts
interface RouteContext {
  request: IncomingRequest;
  tenant?: string;        // set by stage 1
  version?: string;       // set by stage 2
  variant?: string;       // set by stage 3
  sessionId?: string;     // for sticky affinity
  target?: WorkerAddress; // set by stage 4/5 — the chosen replica
}
type Stage = (ctx: RouteContext, next: () => Promise<void>) => Promise<void>;

// Frozen ORDER — each stage is a pass-through until its epic fills it in:
const PIPELINE: Stage[] = [
  authResolveTenant,   // 1 — epic 10 (resolve tenant from caller auth; reject unauth here)
  selectVersion,       // 2 — epic 08 (stable vs canary split); triggers (11) enter HERE
  selectVariant,       // 3 — epic 12 (capability → cost → latency)
  stickyAffinity,      // 4 — epic 04 (pin session→replica; see "stickiness wins" below)
  loadBalance,         // 5 — epic 09 core (pick a healthy replica from the registry)
];
```

## Stickiness wins over canary (frozen)
A session's canary bucket is decided **once, at session start** (stage 2, recorded in the State
Store under the session), then **pinned**. On subsequent calls stage 4 reads the pin and stage 2 is
a no-op for that session → **a live session never flips version mid-run.** New sessions get
freshly bucketed, so canary still ramps. (Trade-off: conversational consistency over fastest
possible canary signal — locked.)

## Worker registry (frozen, resolves open questions)
- v1 internal addressing = a **worker registry** (`name@version → host:port`, health), stored via
  the State Store under `_system/workers/…` (C3). **Not** mesh/DNS — a mesh adapter is a later
  option behind the same registry interface.
- Router runs as a **separate process** in front of the fleet (not embedded in cloudflared); the
  Cloudflare tunnel (`tunnel.ts`) sits *in front of the router* for `expose: public`. Boundary:
  **router decides which worker; tunnel exposes to the internet** — distinct components.
- Triggers (epic 11) call the pipeline at stage 2 as just another request source.

## Packaging (delivers ADR-0012)
`Dockerfile` (Python runtime + cloudflared; model external per ADR-0019) + no-Node shim
(`curl | sh`) wrapping `docker run`. `airlock deploy worker.yaml` runs the container and registers
it; `airlock expose`/`unexpose` open/close the public tunnel live (no rebuild).

## File-by-file
- **new** `Dockerfile`, shim script, `router/` (pipeline + stage no-ops + registry client).
- **edit** `up.ts` — stop spawning `python3`; run the container; register the worker.
- **edit** `exec.ts` — `deploy`/`expose`/`unexpose` builders (replace wrangler-only target).
- **reuse** `tunnel.ts` — named/durable tunnel machinery for `expose: public` (front of router).
- **schema** — `expose` block in `worker.schema.json` (epic 07, C2).
- **registry** keys under `_system/workers/…` via the State Store (epic 04, C3).

## Verification → test layers
- **L3/L4:** `deploy` → internal endpoint in registry, reachable; `expose`→public URL same routes,
  `unexpose` closes it, no rebuild; ≥2 replicas load-balance + version split.
- **L1:** pipeline runs stages in frozen order; each no-op stage passes through; **stickiness test**
  — a session pinned to v1 stays on v1 after a canary to v2 is started; a *new* session can land on
  v2. (Manual/L5: real Cloudflare durable tunnel — real creds.)
