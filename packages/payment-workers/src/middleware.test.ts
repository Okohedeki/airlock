import { type PaymentConfig, PaymentConfigSchema } from '@airlock-deploy/payment-core';
import { encodePaymentSignatureHeader } from '@x402/core/http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type PaymentFacilitator, withPayment } from './middleware.js';

const WALLET = '0x1234567890abcdef1234567890abcdef12345678';

function flatConfig(overrides: Partial<PaymentConfig> = {}): PaymentConfig {
  return PaymentConfigSchema.parse({
    wallet: WALLET,
    mode: 'flat',
    priceUsdc: '0.01',
    ...overrides,
  });
}

const validPaymentHeader = encodePaymentSignatureHeader({
  x402Version: 1,
  scheme: 'exact',
  network: 'base',
  payload: { signature: '0xdeadbeef', from: '0xpayer' },
});

function mockFacilitator(overrides: Partial<PaymentFacilitator> = {}): PaymentFacilitator {
  return {
    verify: vi.fn().mockResolvedValue({ isValid: true, payer: '0xpayer' }),
    settle: vi.fn().mockResolvedValue({
      success: true,
      transaction: '0xabc',
      network: 'base',
      payer: '0xpayer',
    }),
    ...overrides,
  };
}

const okHandler = () => new Response('ok', { status: 200 });

const env = {};
const ctx = {} as ExecutionContext;

describe('withPayment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('bypasses the payment flow entirely when config.enabled is false', async () => {
    const facilitator = mockFacilitator();
    const handler = vi.fn(okHandler);
    const wrapped = withPayment(flatConfig({ enabled: false }), handler, { facilitator });

    const res = await wrapped(new Request('https://agent.test/run'), env, ctx);

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    expect(facilitator.verify).not.toHaveBeenCalled();
  });

  it('returns 402 with PaymentRequired body when X-PAYMENT is missing', async () => {
    const facilitator = mockFacilitator();
    const wrapped = withPayment(flatConfig(), okHandler, { facilitator });

    const res = await wrapped(new Request('https://agent.test/run'), env, ctx);

    expect(res.status).toBe(402);
    const body = (await res.json()) as { x402Version: number; accepts: unknown[] };
    expect(body.x402Version).toBe(1);
    expect(body.accepts).toHaveLength(1);
    expect(facilitator.verify).not.toHaveBeenCalled();
  });

  it('returns 402 when the X-PAYMENT header is malformed', async () => {
    const facilitator = mockFacilitator();
    const wrapped = withPayment(flatConfig(), okHandler, { facilitator });

    const res = await wrapped(
      new Request('https://agent.test/run', { headers: { 'X-PAYMENT': 'not-base64-json!!!' } }),
      env,
      ctx,
    );

    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/malformed/i);
  });

  it('returns 402 when the facilitator rejects the payment', async () => {
    const facilitator = mockFacilitator({
      verify: vi.fn().mockResolvedValue({ isValid: false, invalidReason: 'bad signature' }),
    });
    const handler = vi.fn(okHandler);
    const wrapped = withPayment(flatConfig(), handler, { facilitator });

    const res = await wrapped(
      new Request('https://agent.test/run', { headers: { 'X-PAYMENT': validPaymentHeader } }),
      env,
      ctx,
    );

    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/bad signature/);
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs the handler and attaches X-PAYMENT-RESPONSE on a successful payment', async () => {
    const facilitator = mockFacilitator();
    const handler = vi.fn(okHandler);
    const wrapped = withPayment(flatConfig(), handler, { facilitator });

    const res = await wrapped(
      new Request('https://agent.test/run', { headers: { 'X-PAYMENT': validPaymentHeader } }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(handler).toHaveBeenCalledOnce();
    expect(facilitator.verify).toHaveBeenCalledOnce();
    expect(facilitator.settle).toHaveBeenCalledOnce();
    expect(res.headers.get('X-PAYMENT-RESPONSE')).toBeTruthy();
  });

  it('returns 402 if settlement fails after the handler runs', async () => {
    const facilitator = mockFacilitator({
      settle: vi.fn().mockResolvedValue({ success: false, errorReason: 'on-chain revert' }),
    });
    const wrapped = withPayment(flatConfig(), okHandler, { facilitator });

    const res = await wrapped(
      new Request('https://agent.test/run', { headers: { 'X-PAYMENT': validPaymentHeader } }),
      env,
      ctx,
    );

    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/on-chain revert/);
  });

  it('returns 501 for per_token mode in v1', async () => {
    const config = PaymentConfigSchema.parse({
      wallet: WALLET,
      mode: 'per_token',
      pricePerTokenUsdc: '0.000001',
      minCreditBalanceUsdc: '0.10',
    });
    const wrapped = withPayment(config, okHandler);

    const res = await wrapped(new Request('https://agent.test/run'), env, ctx);

    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/per_token/);
  });
});
