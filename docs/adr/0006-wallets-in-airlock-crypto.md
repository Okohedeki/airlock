# Wallet operations live in a separate repo (airlock-crypto)

> **Status (2026-06-03): Superseded.** Payments are removed; the `WalletProvider` seam and airlock-crypto are out of scope ([redesign epic 00](../redesign/plans/00-foundations-strip-crypto-config-reset.md)). (Supersedes the older in-body `## Status (2026-05-26)`.)

Creating wallets, funding them, and transferring USDC are a distinct concern from wrapping an agent with a paywall and deploying it. We chose to keep all wallet/key/on-chain money-movement logic in a **separate repo, `airlock-crypto`**, rather than in the main `airlock` repo. The main repo codes against a small seam (`WalletProvider` in `@airlockhq/payment-core`); `airlock-crypto` implements it later. The seam ships now as `unavailableWalletProvider`, which throws on every method.

This is deliberately deferred: v1's paid path does not need wallet creation/funding/transfer at all — publishers supply their own `wallet` address and x402 settlement runs through the Facilitator (`PaymentFacilitator`). We wire `airlock-crypto` in only after the core wrap → deploy → payment-verify loop has proven out in live tests. Consequently the prepaid / deferred-settlement latency work, which is entangled with on-chain money movement, is also deferred; the non-crypto latency wins (in-process middleware, tunnel region pinning, warm instances) proceed independently.

## Considered Options

- **Build wallets into `airlock` now** — couples custody/key-management and a separate security surface into the core CLI before the core loop is even proven. Rejected.
- **Separate repo `airlock-crypto`, seam in payment-core, deferred implementation** — keeps the boundary clean, lets the core loop prove out first, and lets the crypto repo evolve on its own cadence. Chosen.
- **Third-party custodial wallet SDK inline** — premature; we don't yet know the wallet requirements, and it would bake a vendor choice into core. Revisit inside `airlock-crypto`.

## Status (2026-05-26)

`airlock-crypto` v1 now exists as a **Python-first** package — scoped as a thin **x402 transaction layer for agent wallets** (buy *and* sell), not a custodial wallet product or exchange. It implements the `WalletProvider` operations (create/import/fund/balance/transfer) plus the missing **payer** side: `pay(url, max_price, cap)` autopays an x402 paywall via the x402 SDK (exact EIP-3009), enforcing a **self-custody, per-wallet spend cap** so an autonomous loop can't drain the wallet. A `selling_env`/`selling_config` helper flips on airlock's existing receiver middleware — self-custody on buy, address-only on sell, so the no-custody stance (ADR-0005) holds on both sides. The TS `WalletProvider` seam stays a stub for now (method names kept aligned). airlock-agent exposes buying as an **optional** capability (`pip install 'airlock-agent[crypto]'` → `airlock_agent.tools.buy`), gated separately because airlock-crypto requires Python ≥3.10.
