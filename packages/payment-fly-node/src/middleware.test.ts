import {
  type CallReporter,
  InMemoryCreditLedger,
  type PaymentConfig,
  PaymentConfigSchema,
  SESSION_HEADER,
  TOKENS_USED_HEADER,
} from '@airlockhq/payment-core';
import { encodePaymentSignatureHeader } from '@x402/core/http';
import type { NextFunction, Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type AgentHandler, type PaymentFacilitator, withPaymentExpress } from './middleware.js';

const WALLET = '0x1234567890abcdef1234567890abcdef12345678';
const PAYER = '0xpayer000000000000000000000000000000000001';

function flatConfig(overrides: Partial<PaymentConfig> = {}): PaymentConfig {
  return PaymentConfigSchema.parse({
    wallet: WALLET,
    mode: 'flat',
    priceUsdc: '0.01',
    ...overrides,
  });
}

function perTokenConfig(overrides: Partial<PaymentConfig> = {}): PaymentConfig {
  return PaymentConfigSchema.parse({
    wallet: WALLET,
    mode: 'per_token',
    pricePerTokenUsdc: '0.000001',
    minCreditBalanceUsdc: '0.10',
    ...overrides,
  });
}

const validPaymentHeader = encodePaymentSignatureHeader({
  x402Version: 1,
  scheme: 'exact',
  network: 'base',
  payload: { signature: '0xdeadbeef', from: PAYER },
});

function mockFacilitator(overrides: Partial<PaymentFacilitator> = {}): PaymentFacilitator {
  return {
    verify: vi.fn().mockResolvedValue({ isValid: true, payer: PAYER }),
    settle: vi.fn().mockResolvedValue({
      success: true,
      transaction: '0xabc',
      network: 'base',
      payer: PAYER,
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
  const finishListeners: Array<() => void> = [];
  const writeBuf: string[] = [];

  const fireFinish = () => {
    if (sent) return;
    sent = true;
    for (const l of finishListeners) l();
  };

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
    flushHeaders() {
      // no-op for mock
    },
    write(chunk: Buffer | Uint8Array | string) {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString();
      writeBuf.push(text);
      return true;
    },
    json(b: unknown) {
      body = b;
      fireFinish();
      return res as MockRes;
    },
    send(b: unknown) {
      body = b;
      fireFinish();
      return res as MockRes;
    },
    end(b?: unknown) {
      if (b !== undefined) {
        body = b;
      } else if (writeBuf.length > 0) {
        body = writeBuf.join('');
      }
      fireFinish();
      return res as MockRes;
    },
    // biome-ignore lint/suspicious/noExplicitAny: Express event API
    on(event: string, listener: (...args: any[]) => void) {
      if (event === 'finish') finishListeners.push(listener as () => void);
      return res as MockRes;
    },
    _state: () => ({ status, headers, body, sent }),
  };
  return res as MockRes;
}

function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

const noopNext: NextFunction = () => {};
const okHandler: AgentHandler = async () => ({ status: 200, body: { ok: true } });
const tokensHandler =
  (tokens: number): AgentHandler =>
  async () => ({
    status: 200,
    headers: { [TOKENS_USED_HEADER]: String(tokens) },
    body: { ok: true },
  });

describe('withPaymentExpress — flat mode', () => {
  beforeEach(() => vi.clearAllMocks());

  it('bypasses when enabled=false', async () => {
    const facilitator = mockFacilitator();
    const handler = vi.fn(okHandler);
    const mw = withPaymentExpress(flatConfig({ enabled: false }), handler, { facilitator });

    const res = mockRes();
    await mw(mockReq(), res, noopNext);

    expect(res._state().status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    expect(facilitator.verify).not.toHaveBeenCalled();
  });

  it('returns 402 with PaymentRequired when X-PAYMENT is missing', async () => {
    const mw = withPaymentExpress(flatConfig(), okHandler, { facilitator: mockFacilitator() });
    const res = mockRes();
    await mw(mockReq(), res, noopNext);
    const s = res._state();
    expect(s.status).toBe(402);
    expect(s.body).toMatchObject({ x402Version: 1 });
  });

  it('returns 402 when X-PAYMENT is malformed', async () => {
    const mw = withPaymentExpress(flatConfig(), okHandler, { facilitator: mockFacilitator() });
    const res = mockRes();
    await mw(mockReq({ headers: { 'X-PAYMENT': 'not-base64-json!!!' } }), res, noopNext);
    expect(res._state().status).toBe(402);
    expect((res._state().body as { error: string }).error).toMatch(/malformed/i);
  });

  it('returns 402 when the facilitator rejects', async () => {
    const facilitator = mockFacilitator({
      verify: vi.fn().mockResolvedValue({ isValid: false, invalidReason: 'bad signature' }),
    });
    const mw = withPaymentExpress(flatConfig(), okHandler, { facilitator });
    const res = mockRes();
    await mw(mockReq({ headers: { 'X-PAYMENT': validPaymentHeader } }), res, noopNext);
    expect(res._state().status).toBe(402);
  });

  it('runs the handler and attaches X-PAYMENT-RESPONSE on success', async () => {
    const facilitator = mockFacilitator();
    const mw = withPaymentExpress(flatConfig(), okHandler, { facilitator });
    const res = mockRes();
    await mw(mockReq({ headers: { 'X-PAYMENT': validPaymentHeader } }), res, noopNext);
    const s = res._state();
    expect(s.status).toBe(200);
    expect(s.headers['X-PAYMENT-RESPONSE']).toBeTruthy();
    expect(facilitator.settle).toHaveBeenCalledOnce();
  });

  it('returns 402 if settlement fails', async () => {
    const facilitator = mockFacilitator({
      settle: vi.fn().mockResolvedValue({ success: false, errorReason: 'on-chain revert' }),
    });
    const mw = withPaymentExpress(flatConfig(), okHandler, { facilitator });
    const res = mockRes();
    await mw(mockReq({ headers: { 'X-PAYMENT': validPaymentHeader } }), res, noopNext);
    expect(res._state().status).toBe(402);
    expect((res._state().body as { error: string }).error).toMatch(/on-chain revert/);
  });

  it('forwards thrown errors to next()', async () => {
    const facilitator = mockFacilitator();
    const boom: AgentHandler = async () => {
      throw new Error('handler exploded');
    };
    const mw = withPaymentExpress(flatConfig(), boom, { facilitator });
    const next = vi.fn();
    await mw(mockReq({ headers: { 'X-PAYMENT': validPaymentHeader } }), mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('withPaymentExpress — per_token mode', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 402 when no X-PAYMENT and no session', async () => {
    const mw = withPaymentExpress(perTokenConfig(), okHandler, {
      facilitator: mockFacilitator(),
      ledger: new InMemoryCreditLedger(),
    });
    const res = mockRes();
    await mw(mockReq(), res, noopNext);
    expect(res._state().status).toBe(402);
  });

  it('topup call: settles, credits, runs handler, debits tokens, returns session', async () => {
    const facilitator = mockFacilitator();
    const ledger = new InMemoryCreditLedger();
    const mw = withPaymentExpress(perTokenConfig(), tokensHandler(1000), { facilitator, ledger });

    const res = mockRes();
    await mw(mockReq({ headers: { 'X-PAYMENT': validPaymentHeader } }), res, noopNext);

    const s = res._state();
    expect(s.status).toBe(200);
    expect(s.headers[SESSION_HEADER]).toBeTruthy();
    expect(s.headers['X-PAYMENT-RESPONSE']).toBeTruthy();
    expect(facilitator.settle).toHaveBeenCalledOnce();
    expect(await ledger.getBalance(PAYER)).toBe('0.099');
  });

  it('session-token call draws down balance without re-paying', async () => {
    const facilitator = mockFacilitator();
    const ledger = new InMemoryCreditLedger();
    const mw = withPaymentExpress(perTokenConfig(), tokensHandler(500), { facilitator, ledger });

    const first = mockRes();
    await mw(mockReq({ headers: { 'X-PAYMENT': validPaymentHeader } }), first, noopNext);
    const session = first._state().headers[SESSION_HEADER];
    expect(session).toBeTruthy();

    vi.clearAllMocks();
    const second = mockRes();
    await mw(mockReq({ headers: { [SESSION_HEADER]: session as string } }), second, noopNext);

    expect(second._state().status).toBe(200);
    expect(facilitator.verify).not.toHaveBeenCalled();
    expect(facilitator.settle).not.toHaveBeenCalled();
    expect(await ledger.getBalance(PAYER)).toBe('0.099');
  });

  it('returns 402 when supplied session token is unknown', async () => {
    const mw = withPaymentExpress(perTokenConfig(), okHandler, {
      facilitator: mockFacilitator(),
      ledger: new InMemoryCreditLedger(),
    });
    const res = mockRes();
    await mw(mockReq({ headers: { [SESSION_HEADER]: 'als_bogus' } }), res, noopNext);
    expect(res._state().status).toBe(402);
    expect((res._state().body as { error: string }).error).toMatch(/invalid|expired/i);
  });

  it('fires the reporter with paid-call details on success', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response('', { status: 200 });
    }) as typeof fetch;
    const reporter: CallReporter = {
      url: 'http://backend.test',
      token: 'tok',
      projectName: 'my-agent',
      fetchImpl,
    };
    const mw = withPaymentExpress(perTokenConfig(), tokensHandler(1000), {
      facilitator: mockFacilitator(),
      ledger: new InMemoryCreditLedger(),
      reporter,
    });

    const res = mockRes();
    await mw(mockReq({ headers: { 'X-PAYMENT': validPaymentHeader } }), res, noopNext);
    await new Promise((r) => setImmediate(r));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://backend.test/api/inspect');
    expect(calls[0]?.body).toMatchObject({
      project_name: 'my-agent',
      caller: PAYER,
      status: 200,
      tokens_used: 1000,
      payment_settled: true,
    });
  });

  it('streams an SSE response through the middleware and debits parsed tokens', async () => {
    const facilitator = mockFacilitator();
    const ledger = new InMemoryCreditLedger();
    const sseChunks = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" there"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":7,"total_tokens":10}}\n\n',
      'data: [DONE]\n\n',
    ];
    const streamingHandler: AgentHandler = async () => ({
      status: 200,
      stream: makeStream(sseChunks),
    });

    const mw = withPaymentExpress(perTokenConfig(), streamingHandler, { facilitator, ledger });
    const res = mockRes();
    await mw(mockReq({ headers: { 'X-PAYMENT': validPaymentHeader } }), res, noopNext);
    const s = res._state();

    expect(s.status).toBe(200);
    expect(s.headers[SESSION_HEADER]).toBeTruthy();
    // Body has been built up by chunked writes
    expect(String(s.body)).toContain('"total_tokens":10');
    // Balance: credited 0.10, debited 10 * 0.000001 = 0.00001 → 0.09999
    expect(await ledger.getBalance(PAYER)).toBe('0.09999');
  });

  it('streams cleanly when upstream emits no usage payload (tokens=0, no debit)', async () => {
    const ledger = new InMemoryCreditLedger();
    const sseChunks = ['data: {"choices":[{"delta":{"content":"alpha"}}]}\n\n', 'data: [DONE]\n\n'];
    const mw = withPaymentExpress(
      perTokenConfig(),
      async () => ({ status: 200, stream: makeStream(sseChunks) }),
      { facilitator: mockFacilitator(), ledger },
    );

    const res = mockRes();
    await mw(mockReq({ headers: { 'X-PAYMENT': validPaymentHeader } }), res, noopNext);
    // Full topup amount remains; no debit because no usage parsed
    expect(await ledger.getBalance(PAYER)).toBe('0.1');
  });

  it('returns 402 once balance is fully depleted', async () => {
    const config = perTokenConfig({ minCreditBalanceUsdc: '0.10', pricePerTokenUsdc: '0.05' });
    const facilitator = mockFacilitator();
    const ledger = new InMemoryCreditLedger();
    const mw = withPaymentExpress(config, tokensHandler(1), { facilitator, ledger });

    const r1 = mockRes();
    await mw(mockReq({ headers: { 'X-PAYMENT': validPaymentHeader } }), r1, noopNext);
    expect(r1._state().status).toBe(200);
    const session = r1._state().headers[SESSION_HEADER] as string;
    expect(await ledger.getBalance(PAYER)).toBe('0.05');

    const r2 = mockRes();
    await mw(mockReq({ headers: { [SESSION_HEADER]: session } }), r2, noopNext);
    expect(r2._state().status).toBe(200);
    expect(await ledger.getBalance(PAYER)).toBe('0');

    const r3 = mockRes();
    await mw(mockReq({ headers: { [SESSION_HEADER]: session } }), r3, noopNext);
    expect(r3._state().status).toBe(402);
    expect((r3._state().body as { error: string }).error).toMatch(/depleted|top up/i);
  });
});
