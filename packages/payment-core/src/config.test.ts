import { describe, expect, it } from 'vitest';
import { PaymentConfigSchema, resolveAsset, USDC_ADDRESSES } from './config.js';

const VALID_FLAT = {
  wallet: '0x1234567890abcdef1234567890abcdef12345678',
  mode: 'flat',
  priceUsdc: '0.01',
};

const VALID_PER_TOKEN = {
  wallet: '0x1234567890abcdef1234567890abcdef12345678',
  mode: 'per_token',
  pricePerTokenUsdc: '0.000001',
  minCreditBalanceUsdc: '0.10',
};

describe('PaymentConfigSchema', () => {
  it('accepts a minimal flat config and applies defaults', () => {
    const parsed = PaymentConfigSchema.parse(VALID_FLAT);
    expect(parsed.enabled).toBe(true);
    expect(parsed.network).toBe('base');
    expect(parsed.facilitatorUrl).toBe('https://facilitator.x402.org');
    if (parsed.mode === 'flat') {
      expect(parsed.priceUsdc).toBe('0.01');
    }
  });

  it('accepts a minimal per_token config', () => {
    const parsed = PaymentConfigSchema.parse(VALID_PER_TOKEN);
    if (parsed.mode === 'per_token') {
      expect(parsed.pricePerTokenUsdc).toBe('0.000001');
      expect(parsed.minCreditBalanceUsdc).toBe('0.10');
    }
  });

  it('rejects a non-EVM wallet address', () => {
    expect(() => PaymentConfigSchema.parse({ ...VALID_FLAT, wallet: 'not-an-address' })).toThrow();
  });

  it('rejects negative or non-numeric prices', () => {
    expect(() => PaymentConfigSchema.parse({ ...VALID_FLAT, priceUsdc: '-1' })).toThrow();
    expect(() => PaymentConfigSchema.parse({ ...VALID_FLAT, priceUsdc: 'free' })).toThrow();
  });

  it('rejects an unknown network', () => {
    expect(() => PaymentConfigSchema.parse({ ...VALID_FLAT, network: 'arbitrum-one' })).toThrow();
  });

  it('rejects flat config that omits priceUsdc', () => {
    const { priceUsdc: _, ...rest } = VALID_FLAT;
    expect(() => PaymentConfigSchema.parse(rest)).toThrow();
  });

  it('rejects per_token config that omits minCreditBalanceUsdc', () => {
    const { minCreditBalanceUsdc: _, ...rest } = VALID_PER_TOKEN;
    expect(() => PaymentConfigSchema.parse(rest)).toThrow();
  });
});

describe('resolveAsset', () => {
  it('defaults to USDC for the configured network', () => {
    const parsed = PaymentConfigSchema.parse({ ...VALID_FLAT, network: 'base-sepolia' });
    expect(resolveAsset(parsed)).toBe(USDC_ADDRESSES['base-sepolia']);
  });

  it('honors an explicit asset address override', () => {
    const explicit = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const parsed = PaymentConfigSchema.parse({ ...VALID_FLAT, asset: explicit });
    expect(resolveAsset(parsed)).toBe(explicit);
  });
});
