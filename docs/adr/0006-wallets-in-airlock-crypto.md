# Wallet operations live in a separate repo (airlock-crypto)

Creating wallets, funding them, and transferring USDC are a distinct concern from wrapping an agent with a paywall and deploying it. We chose to keep all wallet/key/on-chain money-movement logic in a **separate repo, `airlock-crypto`**, rather than in the main `airlock` repo. The main repo codes against a small seam (`WalletProvider` in `@airlockhq/payment-core`); `airlock-crypto` implements it later. The seam ships now as `unavailableWalletProvider`, which throws on every method.

This is deliberately deferred: v1's paid path does not need wallet creation/funding/transfer at all — publishers supply their own `wallet` address and x402 settlement runs through the Facilitator (`PaymentFacilitator`). We wire `airlock-crypto` in only after the core wrap → deploy → payment-verify loop has proven out in live tests. Consequently the prepaid / deferred-settlement latency work, which is entangled with on-chain money movement, is also deferred; the non-crypto latency wins (in-process middleware, tunnel region pinning, warm instances) proceed independently.

## Considered Options

- **Build wallets into `airlock` now** — couples custody/key-management and a separate security surface into the core CLI before the core loop is even proven. Rejected.
- **Separate repo `airlock-crypto`, seam in payment-core, deferred implementation** — keeps the boundary clean, lets the core loop prove out first, and lets the crypto repo evolve on its own cadence. Chosen.
- **Third-party custodial wallet SDK inline** — premature; we don't yet know the wallet requirements, and it would bake a vendor choice into core. Revisit inside `airlock-crypto`.
