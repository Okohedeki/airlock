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
| **Durable self-host URL (BYO Cloudflare)** — `airlock up --durable`: stable hostname on the publisher's OWN Cloudflare account via `startNamedTunnel(token)`; `[tunnel]` config block + `AIRLOCK_CF_TUNNEL_TOKEN`; `doctor` credential-clarity checks; `docs/durable-hosting.md`. airlock holds no keys. | ✅ committed + pushed (`6d85a26`) |
| **Scale & latency (Cloudflare)** — latency-aware admission (EWMA + `AIRLOCK_MAX_WAIT_S` budget + `429`/`Retry-After`); SSE streaming Tier A (heartbeat, every harness) + Tier B mechanism (`run_stream`); per-token streamed billing; connector tuning (`--cf-*`/`[tunnel]`) + supervision (reconnect w/ backoff); `/metrics`. Multi-box = N connectors on one token. ADR-0011, `docs/scaling-cloudflare.md`. **Short-term done; long-term open (see What's next).** | ✅ committed + pushed (`6d85a26`) |
| **Credential templates** — committed `.env.example` per repo (gitignored `.env`), scoped per service: deploy = CF tunnel token + model keys + optional buy-tool/Fly/dashboard. Pushed 2026-05-27. | ✅ |
| **Config-driven harness binding** — `[agent]` block + `airlock init --detect`; 5 harnesses (smolagents/langgraph/crewai/openai-agents/claude) + custom; no adapter to write | ✅ |
| **Payment middleware** — in-process x402, Python (`payment-fly`) + TS (`payment-workers`, `payment-fly-node`); flat + per-token (incl. streamed); Facilitator-delegated | ✅ |
| **Capped-parallel concurrency** — per-call isolation + bounded queue (ADR-0010); now latency-aware admission (ADR-0011); `scripts/concurrency-check.sh` | ✅ |
| **Optional buy tool** — `airlock_agent.tools.buy` behind `airlock-agent[crypto]` → an agent pays other agents (uses sister repo airlock-crypto) | ✅ |
| **Dashboard/server** — GitHub OAuth, projects, inspect store | ✅ |
| Docs | `CONTEXT.md` glossary, `docs/adr/0001..0011`, `docs/scaling-cloudflare.md` | ✅ |
| Tests | cli 86 · agent-runtime 45 · payment-fly 39 · payment-core 36 · server 30 · payment-workers 12 · payment-fly-node 18 — all green | ✅ |

Runtime packages: `python/agent-runtime` (`airlock-agent`), `python/payment-fly` (`airlock-payment`); CLI in `packages/cli`; shared `packages/payment-core`.

## What's next (prioritized; see README Roadmap for the public list)

1. **Scale & latency — LONG-TERM (short-term shipped in `6d85a26`; ADR-0011, `docs/scaling-cloudflare.md`).** Per-box admission + streaming + tunnel tuning/supervision are done. The headline: **the model, not airlock, is the concurrency unit** (4 "parallel" runs = ~5× slower each, proven live). What's still short-term-only and needs the long-term fix:
   - **Per-harness Tier B streaming** — wire smolagents/langgraph/claude into the shipped `run_stream` interface; needs a **live model** to verify the step→delta mapping (not stubs). *(See task #6 in the agent task list.)*
   - **Adaptive concurrency (AIMD)** — auto-tune the *effective* cap from the run-time EWMA so a mis-set `AIRLOCK_MAX_CONCURRENCY` can't over-subscribe the model. Today the cap is operator-set; admission is latency-aware but the cap is not.
   - **Verify + automate multi-box fan-out** — prove N connector replicas on one token against real Cloudflare (needs token + 2nd box); add the **Cloudflare Load Balancing** on-ramp (health pools/regions/failover), optionally via the CF API token.
   - **Model-layer scale story (true ceiling)** — a single non-batching/in-process model still serializes (ADR-0008 — we don't own inference). Detect it + guide to vLLM / `llama-server --parallel` / remote; ship a batching-server recipe; surface in `doctor`/`/metrics`.
   - **Stream cancellation on disconnect** (slot frees but the threadpool run keeps going) + **cluster observability** (Prometheus + cluster-wide saturation beyond per-box 429).
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
