import { describe, expect, it } from 'vitest';
import { _internal, InMemoryCreditLedger, InsufficientBalanceError } from './ledger.js';
import type { CallerId } from './types.js';

const ALICE: CallerId = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BOB: CallerId = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('atomic conversions', () => {
  it('round-trips USDC strings via bigint without float drift', () => {
    const { toAtomic, fromAtomic } = _internal;
    expect(fromAtomic(toAtomic('0.000001') + toAtomic('0.000001'))).toBe('0.000002');
    expect(fromAtomic(toAtomic('0.1') + toAtomic('0.2'))).toBe('0.3');
    expect(fromAtomic(toAtomic('1.000000'))).toBe('1');
    expect(fromAtomic(toAtomic('0'))).toBe('0');
  });
});

describe('InMemoryCreditLedger', () => {
  it('returns "0" for an unknown caller', async () => {
    const ledger = new InMemoryCreditLedger();
    expect(await ledger.getBalance(ALICE)).toBe('0');
  });

  it('credits, then reflects the new balance', async () => {
    const ledger = new InMemoryCreditLedger();
    await ledger.credit(ALICE, '1.00');
    expect(await ledger.getBalance(ALICE)).toBe('1');
  });

  it('debits down to zero successfully', async () => {
    const ledger = new InMemoryCreditLedger();
    await ledger.credit(ALICE, '0.50');
    await ledger.debit(ALICE, '0.50');
    expect(await ledger.getBalance(ALICE)).toBe('0');
  });

  it('throws InsufficientBalanceError when debit exceeds balance', async () => {
    const ledger = new InMemoryCreditLedger();
    await ledger.credit(ALICE, '0.10');
    await expect(ledger.debit(ALICE, '0.11')).rejects.toBeInstanceOf(InsufficientBalanceError);
  });

  it('keeps callers isolated from each other', async () => {
    const ledger = new InMemoryCreditLedger();
    await ledger.credit(ALICE, '1.00');
    expect(await ledger.getBalance(BOB)).toBe('0');
    await ledger.credit(BOB, '0.25');
    expect(await ledger.getBalance(ALICE)).toBe('1');
    expect(await ledger.getBalance(BOB)).toBe('0.25');
  });

  it('aggregates many tiny per-token debits without precision loss', async () => {
    const ledger = new InMemoryCreditLedger();
    await ledger.credit(ALICE, '0.001000');
    for (let i = 0; i < 1000; i++) {
      await ledger.debit(ALICE, '0.000001');
    }
    expect(await ledger.getBalance(ALICE)).toBe('0');
  });
});
