/**
 * Wallet & on-chain money-movement seam.
 *
 * Creating wallets, funding them, and transferring USDC are owned by a SEPARATE
 * repo — `airlock-crypto`. This file is ONLY the boundary the rest of airlock
 * codes against, so that repo can drop in later without touching call sites.
 *
 * STATUS (v1): NOT IMPLEMENTED. {@link unavailableWalletProvider} throws on every
 * method. We wire real wallet ops via `airlock-crypto` only after the core
 * wrap → deploy → payment-verify loop has proven out in live tests.
 *
 * Note this is distinct from payment *settlement*: v1's paid path needs none of
 * this. Publishers supply their own `wallet` address (PaymentConfig.wallet) and
 * x402 settlement runs through the Facilitator (see `PaymentFacilitator`). The
 * WalletProvider seam is for the higher-level lifecycle airlock-crypto will own.
 */

export interface WalletRef {
  address: `0x${string}`;
  /** Network the wallet lives on (e.g. 'base', 'base-sepolia'). */
  network: string;
}

/**
 * The surface `airlock-crypto` will implement. Kept intentionally small — add
 * methods here as airlock-crypto grows, not speculative ones now.
 */
export interface WalletProvider {
  /** Create a fresh wallet on the given network. */
  createWallet(network: string): Promise<WalletRef>;
  /** Fund a wallet with USDC (testnet faucet, or a top-up transfer). */
  fund(wallet: WalletRef, amountUsdc: string): Promise<{ tx: string }>;
  /** Transfer USDC from a wallet to an address. */
  transfer(from: WalletRef, to: `0x${string}`, amountUsdc: string): Promise<{ tx: string }>;
  /** Current USDC balance for a wallet. */
  getBalance(wallet: WalletRef): Promise<string>;
}

export class WalletProviderUnavailableError extends Error {
  constructor(op: string) {
    super(
      `wallet operation "${op}" is unavailable: wallet creation/funding/transfer ` +
        `lives in the separate airlock-crypto repo, which is not wired in yet. ` +
        `v1 uses publisher-supplied wallet addresses + x402 Facilitator settlement.`,
    );
    this.name = 'WalletProviderUnavailableError';
  }
}

/**
 * Placeholder provider until `airlock-crypto` is wired in. Every method rejects.
 * Code may reference this so the seam type-checks today; real ops arrive later.
 */
export const unavailableWalletProvider: WalletProvider = {
  createWallet: () => Promise.reject(new WalletProviderUnavailableError('createWallet')),
  fund: () => Promise.reject(new WalletProviderUnavailableError('fund')),
  transfer: () => Promise.reject(new WalletProviderUnavailableError('transfer')),
  getBalance: () => Promise.reject(new WalletProviderUnavailableError('getBalance')),
};
