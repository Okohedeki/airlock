# Two production Targets at v1

> **Status (2026-06-03): Superseded.** The runtime is one Docker image fronted by the Fleet Router, not a matrix of Targets/Recipes ([ADR-0017](./0017-fleet-router.md), [redesign epic 09](../redesign/plans/09-deploy-expose-and-fleet-router.md)). Already noted historical by [ADR-0012](./0012-docker-first-runtime-model-external.md).

The original plan called for Cloudflare Workers as the single v1 Target. Once we broadened scope to **any HTTP-speaking Agent**, Workers' constraints (no native Python, no containers, no native deps) excluded the majority of AI agent builders — most of whom write Python (LangChain, LangGraph, CrewAI) or ship containerized runtimes. We chose to ship two Recipes at v1: **Cloudflare Workers** (stateless TS, edge) and **Fly.io** (Docker-native, Python + TS + stateful). The Target is chosen explicitly via `--target=` at `init` time and persists for the project's lifetime; we never auto-detect and never silently switch. This appears to violate the "don't abstract until two real Targets exist" rule the project inherited from `airlock`, but the rule is satisfied: both Targets are real on day one. The two Recipes share only the routing layer — no shared Recipe code beyond config keys.

## Considered Options

- **Cloudflare Workers only** — original plan. Rejected: excludes the Python audience, who are the majority of AI agent builders today.
- **Fly.io only** — covers Python + TS + stateful, but gives up Workers' edge latency and best-in-class cold-start performance for the TS-stateless audience.
- **Workers + Fly with auto-detect routing** — picks Target from filesystem signals (Dockerfile → Fly, `wrangler.toml` → Workers). Rejected: silent mis-routing (e.g., TS project that uses `fs.writeFile` deployed to Workers) creates deploy-time successes with runtime failures. Explicit `--target=` puts the architectural choice on the publisher.
- **Dev-only v1, defer prod entirely** — would break the dev → prod pricing funnel and remove the paid wedge.
