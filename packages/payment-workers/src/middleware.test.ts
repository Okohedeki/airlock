import {
  type CallReporter,
  InMemoryCreditLedger,
  type PaymentConfig,
  PaymentConfigSchema,
  SESSION_HEADER,
  TOKENS_USED_HEADER,
} from '@airlockhq/payment-core';
import { encodePaymentSignatureHeader } from '@x402/core/http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type PaymentFacilitator, withPayment } from './middleware.js';

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

const okHandler = () => new Response('ok', { status: 200 });
const env = {};
const ctx = {} as ExecutionContext;

describe('withPayment — flat mode', () => {
  beforeEach(() => vi.clearAllMocks());

  it('bypasses entirely when config.enabled is false', async () => {
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
  });

  it('returns 402 when the X-PAYMENT header is malformed', async () => {
    const wrapped = withPayment(flatConfig(), okHandler, { facilitator: mockFacilitator() });

    const res = await wrapped(
      new Request('https://agent.test/run', { headers: { 'X-PAYMENT': 'not-base64-json!!!' } }),
      env,
      ctx,
    );

    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).toMatch(/malformed/i);
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
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs the handler and attaches X-PAYMENT-RESPONSE on success', async () => {
    const facilitator = mockFacilitator();
    const wrapped = withPayment(flatConfig(), okHandler, { facilitator });

    const res = await wrapped(
      new Request('https://agent.test/run', { headers: { 'X-PAYMENT': validPaymentHeader } }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
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
    expect(((await res.json()) as { error: string }).error).toMatch(/on-chain revert/);
  });
});

describe('withPayment — per_token mode', () => {
  beforeEach(() => vi.clearAllMocks());

  const tokensHandler = (tokens: number) => () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { [TOKENS_USED_HEADER]: String(tokens), 'content-type': 'application/json' },
    });

  it('returns 402 with PaymentRequired when no X-PAYMENT and no session', async () => {
    const wrapped = withPayment(perTokenConfig(), okHandler, {
      facilitator: mockFacilitator(),
      ledger: new InMemoryCreditLedger(),
    });

    const res = await wrapped(new Request('https://agent.test/run'), env, ctx);

    expect(res.status).toBe(402);
    const body = (await res.json()) as { accepts: { maxAmountRequired: string }[] };
    // 0.10 USDC = 100_000 atomic
    expect(body.accepts[0]?.maxAmountRequired).toBe('100000');
  });

  it('topup call settles, credits balance, runs handler, debits tokens, returns session', async () => {
    const facilitator = mockFacilitator();
    const ledger = new InMemoryCreditLedger();
    const wrapped = withPayment(perTokenConfig(), tokensHandler(1000), { facilitator, ledger });

    const res = await wrapped(
      new Request('https://agent.test/run', { headers: { 'X-PAYMENT': validPaymentHeader } }),
      env,
      ctx,
    );

    expect(res.status).toBe(200);
    expect(facilitator.settle).toHaveBeenCalledOnce();
    const sessionToken = res.headers.get(SESSION_HEADER);
    expect(sessionToken).toBeTruthy();
    expect(res.headers.get('X-PAYMENT-RESPONSE')).toBeTruthy();
    // Credited 0.10, debited 1000 * 0.000001 = 0.001 → balance 0.099
    expect(await ledger.getBalance(PAYER)).toBe('0.099');
  });

  it('session-token call draws down balance without re-paying', async () => {
    const facilitator = mockFacilitator();
    const ledger = new InMemoryCreditLedger();
    const wrapped = withPayment(perTokenConfig(), tokensHandler(500), { facilitator, ledger });

    // First call: topup
    const first = await wrapped(
      new Request('https://agent.test/run', { headers: { 'X-PAYMENT': validPaymentHeader } }),
      env,
      ctx,
    );
    const session = first.headers.get(SESSION_HEADER) as string;
    expect(session).toBeTruthy();

    // Clear mocks so we can verify the next call does NOT touch the facilitator
    vi.clearAllMocks();

    // Second call: use the session, no X-PAYMENT
    const second = await wrapped(
      new Request('https://agent.test/run', { headers: { [SESSION_HEADER]: session } }),
      env,
      ctx,
    );

    expect(second.status).toBe(200);
    expect(facilitator.verify).not.toHaveBeenCalled();
    expect(facilitator.settle).not.toHaveBeenCalled();
    // Balance after two calls: 0.10 - (1000 * 0.000001) = 0.099
    expect(await ledger.getBalance(PAYER)).toBe('0.099');
  });

  it('returns 402 when the supplied session token is unknown', async () => {
    const wrapped = withPayment(perTokenConfig(), okHandler, {
      facilitator: mockFacilitator(),
      ledger: new InMemoryCreditLedger(),
    });

    const res = await wrapped(
      new Request('https://agent.test/run', { headers: { [SESSION_HEADER]: 'als_bogus' } }),
      env,
      ctx,
    );

    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).toMatch(/invalid|expired/i);
  });

  it('fires the reporter with paid-call details after a successful topup', async () => {
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
    const wrapped = withPayment(perTokenConfig(), tokensHandler(1000), {
      facilitator: mockFacilitator(),
      ledger: new InMemoryCreditLedger(),
      reporter,
    });

    await wrapped(
      new Request('https://agent.test/run', { headers: { 'X-PAYMENT': validPaymentHeader } }),
      env,
      ctx,
    );
    // Reporter is fire-and-forget; give the microtask queue a turn
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

  it('returns 402 once balance is fully depleted', async () => {
    // pricePerToken = 0.05, so 2 calls of 1 token each drain the 0.10 topup
    const config = perTokenConfig({ minCreditBalanceUsdc: '0.10', pricePerTokenUsdc: '0.05' });
    const facilitator = mockFacilitator();
    const ledger = new InMemoryCreditLedger();
    const wrapped = withPayment(config, tokensHandler(1), { facilitator, ledger });

    // Topup + first call
    const first = await wrapped(
      new Request('https://agent.test/run', { headers: { 'X-PAYMENT': validPaymentHeader } }),
      env,
      ctx,
    );
    expect(first.status).toBe(200);
    const session = first.headers.get(SESSION_HEADER) as string;
    expect(await ledger.getBalance(PAYER)).toBe('0.05');

    // Second call drains to zero
    const second = await wrapped(
      new Request('https://agent.test/run', { headers: { [SESSION_HEADER]: session } }),
      env,
      ctx,
    );
    expect(second.status).toBe(200);
    expect(await ledger.getBalance(PAYER)).toBe('0');

    // Third call should be blocked
    const third = await wrapped(
      new Request('https://agent.test/run', { headers: { [SESSION_HEADER]: session } }),
      env,
      ctx,
    );
    expect(third.status).toBe(402);
    expect(((await third.json()) as { error: string }).error).toMatch(/depleted|top up/i);
  });
});
