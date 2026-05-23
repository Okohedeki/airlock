import { describe, expect, it } from 'vitest';
import { PaymentConfigSchema } from './config.js';
import { _internal, buildPaymentRequired } from './x402.js';

const BASE_CONFIG = {
  wallet: '0x1234567890abcdef1234567890abcdef12345678',
};

describe('usdcToAtomic', () => {
  const cases: Array<[string, string]> = [
    ['0', '0'],
    ['0.01', '10000'],
    ['1', '1000000'],
    ['1.5', '1500000'],
    ['0.000001', '1'],
    ['100', '100000000'],
  ];
  for (const [input, expected] of cases) {
    it(`converts ${input} USDC -> ${expected} atomic`, () => {
      expect(_internal.usdcToAtomic(input)).toBe(expected);
    });
  }
});

describe('buildPaymentRequired', () => {
  it('produces an x402 v1 envelope with the per-call price for flat mode', () => {
    const config = PaymentConfigSchema.parse({
      ...BASE_CONFIG,
      mode: 'flat',
      priceUsdc: '0.05',
    });
    const envelope = buildPaymentRequired(config, 'https://my-agent.fly.dev/predict');
    expect(envelope.x402Version).toBe(1);
    expect(envelope.accepts).toHaveLength(1);
    const req = envelope.accepts[0];
    expect(req).toBeDefined();
    if (!req) throw new Error('accepts[0] missing');
    expect(req.scheme).toBe('exact');
    expect(req.network).toBe('base');
    expect(req.maxAmountRequired).toBe('50000');
    expect(req.resource).toBe('https://my-agent.fly.dev/predict');
    expect(req.payTo).toBe(BASE_CONFIG.wallet);
    expect(envelope.error).toBeUndefined();
  });

  it('uses minCreditBalanceUsdc as the amount and tags the envelope for per_token mode', () => {
    const config = PaymentConfigSchema.parse({
      ...BASE_CONFIG,
      mode: 'per_token',
      pricePerTokenUsdc: '0.000001',
      minCreditBalanceUsdc: '0.50',
    });
    const envelope = buildPaymentRequired(config, 'https://my-agent.fly.dev/chat');
    const req = envelope.accepts[0];
    expect(req).toBeDefined();
    if (!req) throw new Error('accepts[0] missing');
    expect(req.maxAmountRequired).toBe('500000');
    expect(req.extra).toEqual({ mode: 'per_token_topup' });
    expect(envelope.error).toMatch(/credit balance/i);
  });
});
