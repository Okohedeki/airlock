import type { CallerId } from './types.js';

/**
 * Per-token mode store. Tracks per-Caller USDC balances *and* the session
 * tokens we issue after a Caller's first paid call so subsequent calls can
 * draw down the balance without sending a fresh X-PAYMENT every time.
 *
 * Reference implementation is in-memory and per-process. Production
 * deployments back this with the Publisher's own store (Workers KV, Postgres,
 * Redis, …). The middleware accepts any object that satisfies this interface.
 */
export interface CreditLedger {
  /** Current USDC balance for a Caller. Returns "0" if unknown. */
  getBalance(caller: CallerId): Promise<string>;
  /** Add USDC to a Caller's balance (e.g. on x402 top-up settlement). */
  credit(caller: CallerId, amountUsdc: string): Promise<string>;
  /** Subtract USDC from a Caller's balance. Throws InsufficientBalance if it would go negative. */
  debit(caller: CallerId, amountUsdc: string): Promise<string>;
  /** Mint an opaque session token for a Caller; returned in `X-Airlock-Session`. */
  issueSession(caller: CallerId): Promise<string>;
  /** Look up the Caller that owns a session token. Returns null for unknown / expired. */
  verifySession(token: string): Promise<CallerId | null>;
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
 * losing balance + sessions on restart is acceptable. Production setups should
 * wire a persistent impl backed by KV / SQL / Redis.
 */
export class InMemoryCreditLedger implements CreditLedger {
  private balances = new Map<CallerId, bigint>();
  private sessions = new Map<string, CallerId>();

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

  async issueSession(caller: CallerId): Promise<string> {
    const token = `als_${caller}_${randomToken()}`;
    this.sessions.set(token, caller);
    return token;
  }

  async verifySession(token: string): Promise<CallerId | null> {
    return this.sessions.get(token) ?? null;
  }
}

function randomToken(): string {
  // 16 hex chars = 64 bits of entropy. Plenty for opaque session tokens.
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Test-visible exports for atomic conversions. */
export const _internal = { toAtomic, fromAtomic };
