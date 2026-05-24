# x402 for Publisher monetization

Publishers deploying AI agents via `airlock` need a way to charge Callers for inbound calls (token costs, compute, value). We adopted Coinbase's **x402** standard — HTTP 402 Payment Required with signed USDC payments on Base — as the v1 payment rail. The Publisher provides a wallet; Callers pay directly to that wallet via on-chain settlement; we never custody funds, run a Facilitator, or have a payout obligation. This matches ADR-0001 (we don't hold prod traffic) and ADR-0004 (open source, publisher owns everything). Payment enforcement ships as per-Recipe middleware libraries the Publisher imports into their handler — we don't proxy paid requests because we don't sit in the prod request path.

## Considered Options

- **Stripe metered billing** — universal and familiar, but Stripe's practical floor is ~$0.50/call, killing sub-cent per-token pricing that AI agents actually need. Also requires the Publisher to set up a Stripe Connect account, adds KYC/compliance surface for us, and doesn't fit agent-to-agent flows where the Caller is another autonomous agent rather than a human with a credit card.
- **Both rails, Publisher chooses** — doubles integration work, splits the test matrix, and we have no v1 evidence either segment of users is being turned away. Re-evaluate post-v1 if real demand surfaces.

## Consequences

- Callers without a crypto wallet cannot pay. Acceptable for v1: the target audience (agent developers calling other agents) is already crypto-adjacent or willing to set up a wallet for sub-cent USDC.
- We depend on Coinbase's public Facilitator (`https://facilitator.x402.org/`) being available. The `facilitator_url` config key lets Publishers swap to a self-hosted Facilitator if they want, but the default path has a third-party dependency.
- The Publisher's wallet address sits in `.airlock/config.toml`, which is committed to git. A misconfigured wallet means payments route to the wrong address — `airlock doctor` must validate it pre-deploy.
