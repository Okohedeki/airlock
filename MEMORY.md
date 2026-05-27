# MEMORY

State + roadmap snapshot for `Okohedeki/airlock`. Read this when picking up after a context gap. The README is the marketing surface; this is the engineer's working memory. (A scratch task log lives in the gitignored `.airlock-tasks.md`.)

**Last updated:** 2026-05-27

---

## What this is

Run an agent (any harness) behind a **paid, OpenAI-compatible x402 URL** — self-hosted on your hardware or deployed to a cloud **you** own. The **host + sell** core of the airlock ecosystem. airlock holds no keys, operates no hosting on your behalf, and (self-host) stays out of the request path; the model is always the publisher's (ADR-0008). Durable URLs (Cloudflare named tunnel) and deploys (Fly/Workers) all run on the publisher's own accounts.

## What's there (shipped)

| Area | Status |
|---|---|
| **Self-host** — `airlock up`: `python -m airlock_agent` + public Cloudflare tunnel; payment in-process; off-box verified | ✅ |
| **Durable self-host URL (BYO Cloudflare)** — `airlock up --durable`: stable hostname on the publisher's OWN Cloudflare account via `startNamedTunnel(token)`; `[tunnel]` config block + `AIRLOCK_CF_TUNNEL_TOKEN`; `doctor` credential-clarity checks; `docs/durable-hosting.md`. airlock holds no keys. | ✅ impl + tests green; **commit pending** (uncommitted in working tree) |
| **Credential templates** — committed `.env.example` per repo (gitignored `.env`), scoped per service: deploy = CF tunnel token + model keys + optional buy-tool/Fly/dashboard. Pushed 2026-05-27. | ✅ |
| **Config-driven harness binding** — `[agent]` block + `airlock init --detect`; 5 harnesses (smolagents/langgraph/crewai/openai-agents/claude) + custom; no adapter to write | ✅ |
| **Payment middleware** — in-process x402, Python (`payment-fly`) + TS (`payment-workers`, `payment-fly-node`); flat + per-token; Facilitator-delegated | ✅ |
| **Capped-parallel concurrency** — per-call isolation + bounded queue (ADR-0010); `scripts/concurrency-check.sh` | ✅ |
| **Optional buy tool** — `airlock_agent.tools.buy` behind `airlock-agent[crypto]` → an agent pays other agents (uses sister repo airlock-crypto) | ✅ |
| **Dashboard/server** — GitHub OAuth, projects, inspect store | ✅ |
| Docs | `CONTEXT.md` glossary, `docs/adr/0001..0010` | ✅ |
| Tests | cli 77 (was 66; +11 durable-tunnel/Fly) · agent-runtime 38 · payment-fly 39 · payment-core 36 · server 30 · payment-workers 12 · payment-fly-node 18 — all green | ✅ |

Runtime packages: `python/agent-runtime` (`airlock-agent`), `python/payment-fly` (`airlock-payment`); CLI in `packages/cli`; shared `packages/payment-core`.

## What's next (prioritized; see README Roadmap for the public list)

1. **Durable self-host URL — IMPLEMENTED, COMMIT PENDING (BYO Cloudflare).** Code is written + full workspace green (cli 77 incl. new durable/Fly tests) but **still uncommitted** in the deploy working tree — commit/push it next. `airlock up --durable` runs `tunnel.ts` `startNamedTunnel({token,hostname})` against the publisher's OWN Cloudflare account; `[tunnel]` block (`config-file.ts` `TunnelConfigSchema`), token via `AIRLOCK_CF_TUNNEL_TOKEN`, `doctor` checks, `docs/durable-hosting.md`. **Reframe vs. old plan:** no airlock-operated `server/cloudflare.ts` / `/api/self-host/tunnel` minting — airlock runs no infra, the publisher brings the account + domain + token. *Optional follow-up:* automate tunnel+DNS creation via the publisher's CF **API** token.
2. **Fly deploy — BYO, experimental/unproven.** `airlock deploy` wraps `fly deploy` against the publisher's OWN Fly account; scaffolding (`fly.toml`/Dockerfile) exists but **no off-box deploy is verified** — `doctor` flags this. Next: prove it end-to-end against a real Fly account; automate the local-GGUF Dockerfile. (No airlock-owned Fly org / minted token — that managed-hosting design is dropped.)
3. **Shared plumbing** — `db.ts` `mode` + per-mode columns (drop the `target` CHECK → zod), mode-aware `doctor`; **ADR-0009** (dual-deploy, narrows ADR-0001).
4. **airlock-crypto integration** — once it's on PyPI, register the buy tool into the harness adapters; keep the TS `WalletProvider` seam aligned.
5. **Enterprise seams (interfaces only)** — `payment-core/auth.ts` `CallerAuthStrategy`; nullable `org_id`/`owner_kind`; extend `InspectCallSchema`.
6. **Polish** — tunnel region pinning + SIGTERM cleanup; docs (`payment.md`/`cli.md`/`llama-cpp-on-fly.md`); **npm-publish caveat** (vendoring reads repo-root `./python`, not in npm `files` → bundle or git-install before shipping `@airlockhq/cli`).
7. **Stand up airlock-directory** — the searchable "find" layer (the deploy-flag on-ramp side).

## Related repos (the airlock ecosystem)

- [`airlock-config`](https://github.com/Okohedeki/airlock-config) — declare/discover an agent's contract (describe + discover); this repo serves its bundle.
- [`airlock-crypto`](https://github.com/Okohedeki/airlock-crypto) — self-custody agent wallets; buy + sell over x402 (pay).
- **airlock-directory** *(planned)* — searchable registry of agents (find).

## How to use this file

1. Read this for orientation. 2. Skim `README.md` (the two deploy paths + Roadmap) + `CONTEXT.md` (glossary). 3. Skim `docs/adr/` for locked decisions. 4. Pick a "What's next" item. 5. Update this file when the snapshot drifts.
