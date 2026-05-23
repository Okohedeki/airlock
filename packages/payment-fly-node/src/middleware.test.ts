import { type PaymentConfig, PaymentConfigSchema } from '@airlock-deploy/payment-core';
import { encodePaymentSignatureHeader } from '@x402/core/http';
import type { NextFunction, Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type AgentHandler, type PaymentFacilitator, withPaymentExpress } from './middleware.js';

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

function mockReq(opts: { url?: string; headers?: Record<string, string> } = {}): Request {
  const headers = Object.fromEntries(
    Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    protocol: 'https',
    originalUrl: opts.url ?? '/run',
    url: opts.url ?? '/run',
    get: (name: string) => (name.toLowerCase() === 'host' ? 'agent.test' : undefined),
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

interface MockRes extends Response {
  _state: () => { status: number; headers: Record<string, string>; body: unknown; sent: boolean };
}

function mockRes(): MockRes {
  let status = 200;
  let body: unknown;
  let sent = false;
  const headers: Record<string, string> = {};

  const res: Partial<MockRes> = {
    status(n: number) {
      status = n;
      // biome-ignore lint/suspicious/noExplicitAny: Express type
      (res as any).statusCode = n;
      return res as MockRes;
    },
    setHeader(k: string, v: string | number | readonly string[]) {
      headers[k] = String(v);
      return res as MockRes;
    },
    getHeader(k: string) {
      return headers[k];
    },
    json(b: unknown) {
      body = b;
      sent = true;
      return res as MockRes;
    },
    send(b: unknown) {
      body = b;
      sent = true;
      return res as MockRes;
    },
    end(b?: unknown) {
      if (b !== undefined) body = b;
      sent = true;
      return res as MockRes;
    },
    _state: () => ({ status, headers, body, sent }),
  };
  return res as MockRes;
}

const noopNext: NextFunction = () => {};

const okHandler: AgentHandler = async () => ({ status: 200, body: { ok: true } });

describe('withPaymentExpress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('bypasses the payment flow when config.enabled is false', async () => {
    const facilitator = mockFacilitator();
    const handler = vi.fn(okHandler);
    const middleware = withPaymentExpress(flatConfig({ enabled: false }), handler, { facilitator });

    const res = mockRes();
    await middleware(mockReq(), res, noopNext);

    expect(res._state().status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    expect(facilitator.verify).not.toHaveBeenCalled();
  });

  it('returns 402 with PaymentRequired body when X-PAYMENT is missing', async () => {
    const facilitator = mockFacilitator();
    const middleware = withPaymentExpress(flatConfig(), okHandler, { facilitator });

    const res = mockRes();
    await middleware(mockReq(), res, noopNext);

    const state = res._state();
    expect(state.status).toBe(402);
    expect(state.body).toMatchObject({ x402Version: 1 });
    expect((state.body as { accepts: unknown[] }).accepts).toHaveLength(1);
    expect(facilitator.verify).not.toHaveBeenCalled();
  });

  it('returns 402 when X-PAYMENT is malformed', async () => {
    const facilitator = mockFacilitator();
    const middleware = withPaymentExpress(flatConfig(), okHandler, { facilitator });

    const res = mockRes();
    await middleware(mockReq({ headers: { 'X-PAYMENT': 'not-base64-json!!!' } }), res, noopNext);

    const state = res._state();
    expect(state.status).toBe(402);
    expect((state.body as { error: string }).error).toMatch(/malformed/i);
  });

  it('returns 402 when the facilitator rejects the payment', async () => {
    const facilitator = mockFacilitator({
      verify: vi.fn().mockResolvedValue({ isValid: false, invalidReason: 'bad signature' }),
    });
    const handler = vi.fn(okHandler);
    const middleware = withPaymentExpress(flatConfig(), handler, { facilitator });

    const res = mockRes();
    await middleware(mockReq({ headers: { 'X-PAYMENT': validPaymentHeader } }), res, noopNext);

    const state = res._state();
    expect(state.status).toBe(402);
    expect((state.body as { error: string }).error).toMatch(/bad signature/);
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs the handler and attaches X-PAYMENT-RESPONSE on success', async () => {
    const facilitator = mockFacilitator();
    const handler = vi.fn(okHandler);
    const middleware = withPaymentExpress(flatConfig(), handler, { facilitator });

    const res = mockRes();
    await middleware(mockReq({ headers: { 'X-PAYMENT': validPaymentHeader } }), res, noopNext);

    const state = res._state();
    expect(state.status).toBe(200);
    expect(state.body).toEqual({ ok: true });
    expect(handler).toHaveBeenCalledOnce();
    expect(facilitator.settle).toHaveBeenCalledOnce();
    expect(state.headers['X-PAYMENT-RESPONSE']).toBeTruthy();
  });

  it('returns 402 if settlement fails after the handler runs', async () => {
    const facilitator = mockFacilitator({
      settle: vi.fn().mockResolvedValue({ success: false, errorReason: 'on-chain revert' }),
    });
    const middleware = withPaymentExpress(flatConfig(), okHandler, { facilitator });

    const res = mockRes();
    await middleware(mockReq({ headers: { 'X-PAYMENT': validPaymentHeader } }), res, noopNext);

    const state = res._state();
    expect(state.status).toBe(402);
    expect((state.body as { error: string }).error).toMatch(/on-chain revert/);
  });

  it('returns 501 for per_token mode in v1', async () => {
    const config = PaymentConfigSchema.parse({
      wallet: WALLET,
      mode: 'per_token',
      pricePerTokenUsdc: '0.000001',
      minCreditBalanceUsdc: '0.10',
    });
    const middleware = withPaymentExpress(config, okHandler);

    const res = mockRes();
    await middleware(mockReq(), res, noopNext);

    const state = res._state();
    expect(state.status).toBe(501);
    expect((state.body as { error: string }).error).toMatch(/per_token/);
  });

  it('forwards thrown errors to next()', async () => {
    const facilitator = mockFacilitator();
    const boom: AgentHandler = async () => {
      throw new Error('handler exploded');
    };
    const middleware = withPaymentExpress(flatConfig(), boom, { facilitator });
    const next = vi.fn();

    await middleware(mockReq({ headers: { 'X-PAYMENT': validPaymentHeader } }), mockRes(), next);

    expect(next).toHaveBeenCalledOnce();
    expect(next.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });
});
