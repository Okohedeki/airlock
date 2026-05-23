import type { CallerId } from './types.js';

/**
 * Per-token mode Credit Balance store. Tracks the USDC balance each Caller
 * holds against a Publisher's Agent.
 *
 * Reference implementation is in-memory and per-process. Production deployments
 * back this with the Publisher's own store (Workers KV, Postgres, Redis, …).
 * v1 ships the interface only; per-token middleware lands in v1.1 — see
 * `docs/adr/0005-x402-for-monetization.md`.
 */
export interface CreditLedger {
  /** Current USDC balance for a Caller. Returns "0" if unknown. */
  getBalance(caller: CallerId): Promise<string>;
  /** Add USDC to a Caller's balance (e.g. on x402 top-up settlement). */
  credit(caller: CallerId, amountUsdc: string): Promise<string>;
  /** Subtract USDC from a Caller's balance. Throws InsufficientBalance if it would go negative. */
  debit(caller: CallerId, amountUsdc: string): Promise<string>;
}

export class InsufficientBalanceError extends Error {
  constructor(
    public readonly caller: CallerId,
    public readonly required: string,
    public readonly available: string,
  ) {
    super(`caller ${caller} balance ${available} < required ${required}`);
    this.name = 'InsufficientBalanceError';
  }
}

/**
 * USDC arithmetic in atomic units (6 decimals) to avoid float drift.
 */
function toAtomic(usdc: string): bigint {
  const [whole, frac = ''] = usdc.split('.');
  const fracPadded = `${frac}000000`.slice(0, 6);
  return BigInt(`${whole}${fracPadded}`);
}

function fromAtomic(atomic: bigint): string {
  const s = atomic.toString().padStart(7, '0');
  const whole = s.slice(0, -6);
  const frac = s.slice(-6).replace(/0+$/, '');
  return frac === '' ? whole : `${whole}.${frac}`;
}

/**
 * In-memory CreditLedger. Useful for tests and single-process deployments where
 * losing balance on restart is acceptable (it usually isn't — wire a persistent
 * impl in prod).
 */
export class InMemoryCreditLedger implements CreditLedger {
  private balances = new Map<CallerId, bigint>();

  async getBalance(caller: CallerId): Promise<string> {
    return fromAtomic(this.balances.get(caller) ?? 0n);
  }

  async credit(caller: CallerId, amountUsdc: string): Promise<string> {
    const next = (this.balances.get(caller) ?? 0n) + toAtomic(amountUsdc);
    this.balances.set(caller, next);
    return fromAtomic(next);
  }

  async debit(caller: CallerId, amountUsdc: string): Promise<string> {
    const current = this.balances.get(caller) ?? 0n;
    const charge = toAtomic(amountUsdc);
    if (charge > current) {
      throw new InsufficientBalanceError(caller, amountUsdc, fromAtomic(current));
    }
    const next = current - charge;
    this.balances.set(caller, next);
    return fromAtomic(next);
  }
}

/** Test-visible exports for atomic conversions. */
export const _internal = { toAtomic, fromAtomic };
