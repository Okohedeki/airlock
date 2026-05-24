import {
  buildPaymentRequired,
  type CallerId,
  type CreditLedger,
  InMemoryCreditLedger,
  InsufficientBalanceError,
  type PaymentConfig,
  SESSION_HEADER,
  TOKENS_USED_HEADER,
} from '@airlock-deploy/payment-core';
import { decodePaymentSignatureHeader, encodePaymentResponseHeader } from '@x402/core/http';
import { HTTPFacilitatorClient } from '@x402/core/server';
import type { NextFunction, Request, Response } from 'express';

/** Narrow Facilitator surface so tests can stub without the real HTTP client. */
export interface PaymentFacilitator {
  verify(
    paymentPayload: unknown,
    paymentRequirements: unknown,
  ): Promise<{ isValid: boolean; invalidReason?: string; payer?: string }>;
  settle(
    paymentPayload: unknown,
    paymentRequirements: unknown,
  ): Promise<{
    success: boolean;
    errorReason?: string;
    transaction?: string;
    network?: string;
    payer?: string;
  }>;
}

export interface WithPaymentExpressOptions {
  facilitator?: PaymentFacilitator;
  /** Per-token mode only. Defaults to a per-process in-memory ledger. */
  ledger?: CreditLedger;
}

export interface AgentResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export type AgentHandler = (req: Request) => Promise<AgentResponse> | AgentResponse;

const PAYMENT_HEADER = 'x-payment';
const PAYMENT_RESPONSE_HEADER = 'X-PAYMENT-RESPONSE';

/**
 * Wrap a Publisher's async handler in an Express request handler that enforces
 * x402 payment per call. Mirrors `withPayment` in `@airlock-deploy/payment-workers`.
 *
 * - **Flat mode**: every call requires X-PAYMENT; verify → handler → settle.
 * - **Per-token mode**: first call requires X-PAYMENT (topup) and returns an
 *   X-Airlock-Session header. Subsequent calls send that session to draw from
 *   the Caller's Credit Balance; the call cost (X-Tokens-Used × pricePerToken)
 *   is debited. When the balance hits zero, the next call returns 402.
 */
export function withPaymentExpress(
  config: PaymentConfig,
  handler: AgentHandler,
  options: WithPaymentExpressOptions = {},
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const facilitator: PaymentFacilitator =
    options.facilitator ?? new HTTPFacilitatorClient({ url: config.facilitatorUrl });
  const ledger: CreditLedger = options.ledger ?? new InMemoryCreditLedger();

  return async (req, res, next) => {
    try {
      if (!config.enabled) {
        await respond(res, await handler(req));
        return;
      }

      const required = buildPaymentRequired(config, absoluteUrl(req));
      const requirements = required.accepts[0];
      if (!requirements) {
        res.status(500).json({ error: 'internal: no payment requirements built' });
        return;
      }

      if (config.mode === 'per_token') {
        await runPerToken(req, res, config, handler, facilitator, ledger, required);
        return;
      }

      await runFlat(req, res, handler, facilitator, required);
    } catch (err) {
      next(err);
    }
  };
}

async function runFlat(
  req: Request,
  res: Response,
  handler: AgentHandler,
  facilitator: PaymentFacilitator,
  required: ReturnType<typeof buildPaymentRequired>,
): Promise<void> {
  const requirements = required.accepts[0];
  if (!requirements) {
    res.status(500).json({ error: 'internal' });
    return;
  }
  const header = req.header(PAYMENT_HEADER);
  if (!header) {
    res.status(402).json(required);
    return;
  }

  let payload: unknown;
  try {
    payload = decodePaymentSignatureHeader(header);
  } catch {
    res.status(402).json({ ...required, error: 'malformed X-PAYMENT header' });
    return;
  }

  const verify = await facilitator.verify(payload, requirements);
  if (!verify.isValid) {
    res.status(402).json({
      ...required,
      error: verify.invalidReason ?? 'payment verification failed',
    });
    return;
  }

  const agentResponse = await handler(req);

  const settle = await facilitator.settle(payload, requirements);
  if (!settle.success) {
    res.status(402).json({ ...required, error: settle.errorReason ?? 'settlement failed' });
    return;
  }

  res.setHeader(
    PAYMENT_RESPONSE_HEADER,
    encodePaymentResponseHeader(settle as Parameters<typeof encodePaymentResponseHeader>[0]),
  );
  await respond(res, agentResponse);
}

async function runPerToken(
  req: Request,
  res: Response,
  config: PaymentConfig & { mode: 'per_token' },
  handler: AgentHandler,
  facilitator: PaymentFacilitator,
  ledger: CreditLedger,
  required: ReturnType<typeof buildPaymentRequired>,
): Promise<void> {
  const requirements = required.accepts[0];
  if (!requirements) {
    res.status(500).json({ error: 'internal' });
    return;
  }

  const sessionHeader = req.header(SESSION_HEADER);
  const paymentHeader = req.header(PAYMENT_HEADER);

  let caller: CallerId | null = null;
  let settleResult:
    | {
        success: boolean;
        errorReason?: string;
        transaction?: string;
        network?: string;
        payer?: string;
      }
    | undefined;

  if (sessionHeader) {
    caller = await ledger.verifySession(sessionHeader);
    if (!caller) {
      res.status(402).json({ ...required, error: 'invalid or expired session' });
      return;
    }
  } else if (paymentHeader) {
    let payload: unknown;
    try {
      payload = decodePaymentSignatureHeader(paymentHeader);
    } catch {
      res.status(402).json({ ...required, error: 'malformed X-PAYMENT header' });
      return;
    }
    const verify = await facilitator.verify(payload, requirements);
    if (!verify.isValid) {
      res.status(402).json({
        ...required,
        error: verify.invalidReason ?? 'payment verification failed',
      });
      return;
    }
    settleResult = await facilitator.settle(payload, requirements);
    if (!settleResult.success) {
      res.status(402).json({
        ...required,
        error: settleResult.errorReason ?? 'settlement failed',
      });
      return;
    }
    const payer = settleResult.payer ?? verify.payer;
    if (!payer) {
      res.status(500).json({ ...required, error: 'facilitator did not return payer' });
      return;
    }
    caller = payer as CallerId;
    await ledger.credit(caller, config.minCreditBalanceUsdc);
  } else {
    res.status(402).json(required);
    return;
  }

  const balance = await ledger.getBalance(caller);
  if (compareUsdc(balance, '0') <= 0) {
    res.status(402).json({ ...required, error: 'credit balance depleted; top up' });
    return;
  }

  const agentResponse = await handler(req);
  const tokens = readTokensUsed(agentResponse);
  if (tokens > 0) {
    const cost = multiplyUsdc(config.pricePerTokenUsdc, tokens);
    try {
      await ledger.debit(caller, cost);
    } catch (err) {
      if (!(err instanceof InsufficientBalanceError)) throw err;
      // Overdraft tolerated: drain remaining balance and return the response
      await ledger.debit(caller, balance).catch(() => {});
    }
  }

  const issuedSession = sessionHeader ?? (await ledger.issueSession(caller));
  res.setHeader(SESSION_HEADER, issuedSession);
  if (settleResult) {
    res.setHeader(
      PAYMENT_RESPONSE_HEADER,
      encodePaymentResponseHeader(
        settleResult as Parameters<typeof encodePaymentResponseHeader>[0],
      ),
    );
  }
  await respond(res, agentResponse);
}

function readTokensUsed(agent: AgentResponse): number {
  const headerVal = agent.headers?.[TOKENS_USED_HEADER];
  if (!headerVal) return 0;
  const n = Number.parseInt(headerVal, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function absoluteUrl(req: Request): string {
  const proto = req.protocol;
  const host = req.get('host') ?? 'localhost';
  return `${proto}://${host}${req.originalUrl ?? req.url}`;
}

async function respond(res: Response, agent: AgentResponse): Promise<void> {
  res.status(agent.status ?? 200);
  if (agent.headers) {
    for (const [k, v] of Object.entries(agent.headers)) {
      res.setHeader(k, v);
    }
  }
  if (agent.body === undefined) {
    res.end();
    return;
  }
  if (typeof agent.body === 'string') {
    res.send(agent.body);
    return;
  }
  res.json(agent.body);
}

function compareUsdc(a: string, b: string): number {
  const aa = toAtomic(a);
  const bb = toAtomic(b);
  return aa < bb ? -1 : aa > bb ? 1 : 0;
}

function multiplyUsdc(priceUsdc: string, count: number): string {
  const atomic = toAtomic(priceUsdc) * BigInt(count);
  return fromAtomic(atomic);
}

function toAtomic(usdc: string): bigint {
  const [whole, frac = ''] = usdc.split('.');
  return BigInt(`${whole}${`${frac}000000`.slice(0, 6)}`);
}

function fromAtomic(atomic: bigint): string {
  const s = atomic.toString().padStart(7, '0');
  const whole = s.slice(0, -6);
  const frac = s.slice(-6).replace(/0+$/, '');
  return frac === '' ? whole : `${whole}.${frac}`;
}
