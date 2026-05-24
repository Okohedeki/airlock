import {
  buildPaymentRequired,
  type CallerId,
  type CallReporter,
  type CreditLedger,
  InMemoryCreditLedger,
  InsufficientBalanceError,
  type PaymentConfig,
  report,
  SESSION_HEADER,
  TOKENS_USED_HEADER,
} from '@airlockhq/payment-core';
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
  /** Optional fire-and-forget reporter — POSTs each call to the dashboard. */
  reporter?: CallReporter;
}

export interface AgentResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  /**
   * If set, middleware pipes this stream straight through to the client
   * (default Content-Type: text/event-stream) while parsing OpenAI-format
   * SSE chunks for `usage.total_tokens`. `body` is ignored when `stream` is
   * present.
   */
  stream?: ReadableStream<Uint8Array>;
}

export type AgentHandler = (req: Request) => Promise<AgentResponse> | AgentResponse;

const PAYMENT_HEADER = 'x-payment';
const PAYMENT_RESPONSE_HEADER = 'X-PAYMENT-RESPONSE';

/**
 * Wrap a Publisher's async handler in an Express request handler that enforces
 * x402 payment per call. Mirrors `withPayment` in `@airlockhq/payment-workers`.
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
    // Streaming-handled flag: set true synchronously when we'll fire the
    // reporter ourselves (because res headers are flushed before tokens are
    // known, so the res.on('finish') reporter can't get the right value).
    const streamHandled = { value: false };
    if (options.reporter) {
      attachReporter(req, res, options.reporter, config, () => streamHandled.value);
    }
    try {
      if (!config.enabled) {
        await respondAndExtractTokens(res, await handler(req));
        return;
      }

      const required = buildPaymentRequired(config, absoluteUrl(req));
      const requirements = required.accepts[0];
      if (!requirements) {
        res.status(500).json({ error: 'internal: no payment requirements built' });
        return;
      }

      if (config.mode === 'per_token') {
        await runPerToken(
          req,
          res,
          config,
          handler,
          facilitator,
          ledger,
          required,
          options.reporter,
          streamHandled,
        );
        return;
      }

      await runFlat(
        req,
        res,
        handler,
        facilitator,
        required,
        config,
        options.reporter,
        streamHandled,
      );
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Attach a `res.on('finish')` hook that fires the reporter once the response is
 * fully sent. Reads tokens + payer from the response headers we set elsewhere.
 */
function attachReporter(
  req: Request,
  res: Response,
  reporter: CallReporter,
  config: PaymentConfig,
  suppress?: () => boolean,
): void {
  res.on('finish', () => {
    if (suppress?.()) return;
    const tokensHeader = res.getHeader(TOKENS_USED_HEADER);
    const settledHeader = res.getHeader(PAYMENT_RESPONSE_HEADER);
    const tokensStr = typeof tokensHeader === 'string' ? tokensHeader : '';
    const tokens = tokensStr ? Number.parseInt(tokensStr, 10) : null;
    let caller: CallerId | null = null;
    if (typeof settledHeader === 'string') {
      try {
        const decoded = JSON.parse(Buffer.from(settledHeader, 'base64').toString()) as {
          payer?: string;
        };
        if (decoded.payer) caller = decoded.payer as CallerId;
      } catch {
        // ignore malformed
      }
    }
    const settled = settledHeader !== undefined;
    const amount_usdc = settled
      ? config.mode === 'flat'
        ? config.priceUsdc
        : config.minCreditBalanceUsdc
      : null;
    report(reporter, {
      caller,
      status: res.statusCode,
      request_url: absoluteUrl(req),
      tokens_used: tokens !== null && Number.isFinite(tokens) ? tokens : null,
      amount_usdc,
      payment_settled: settled,
    });
  });
}

async function runFlat(
  req: Request,
  res: Response,
  handler: AgentHandler,
  facilitator: PaymentFacilitator,
  required: ReturnType<typeof buildPaymentRequired>,
  config: PaymentConfig,
  reporter: CallReporter | undefined,
  streamHandled: { value: boolean },
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

  // Headers MUST be set before respond() so they reach the client even for streams.
  res.setHeader(
    PAYMENT_RESPONSE_HEADER,
    encodePaymentResponseHeader(settle as Parameters<typeof encodePaymentResponseHeader>[0]),
  );

  // Tell the on('finish') reporter to stand down — we'll fire it ourselves
  // after the stream completes (headers are already flushed by then).
  if (agentResponse.stream) streamHandled.value = true;

  const result = await respondAndExtractTokens(res, agentResponse);

  if (agentResponse.stream && reporter) {
    await report(reporter, {
      caller: (settle.payer ?? null) as CallerId | null,
      status: res.statusCode,
      request_url: absoluteUrl(req),
      tokens_used: result.tokens > 0 ? result.tokens : null,
      amount_usdc: config.mode === 'flat' ? config.priceUsdc : null,
      payment_settled: true,
    });
  }
}

async function runPerToken(
  req: Request,
  res: Response,
  config: PaymentConfig & { mode: 'per_token' },
  handler: AgentHandler,
  facilitator: PaymentFacilitator,
  ledger: CreditLedger,
  required: ReturnType<typeof buildPaymentRequired>,
  reporter: CallReporter | undefined,
  streamHandled: { value: boolean },
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

  // Headers MUST be set before respond() so they reach the client even for streams.
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

  if (agentResponse.stream) streamHandled.value = true;

  // For buffered responses, the handler put X-Tokens-Used on its agent.headers
  // and we can debit *before* writing. For streams, tokens are unknown until
  // pipeAndParseSse drains the upstream — so we debit *after* respond.
  let tokens = readTokensUsed(agentResponse);
  if (!agentResponse.stream && tokens > 0) {
    await debitWithOverdraft(ledger, caller, balance, config.pricePerTokenUsdc, tokens);
  }

  const result = await respondAndExtractTokens(res, agentResponse);

  if (agentResponse.stream) {
    tokens = result.tokens;
    if (tokens > 0) {
      await debitWithOverdraft(ledger, caller, balance, config.pricePerTokenUsdc, tokens);
    }
    if (reporter) {
      await report(reporter, {
        caller,
        status: res.statusCode,
        request_url: absoluteUrl(req),
        tokens_used: tokens > 0 ? tokens : null,
        amount_usdc: settleResult ? config.minCreditBalanceUsdc : null,
        payment_settled: settleResult !== undefined,
      });
    }
  }
}

async function debitWithOverdraft(
  ledger: CreditLedger,
  caller: CallerId,
  balance: string,
  pricePerToken: string,
  tokens: number,
): Promise<void> {
  const cost = multiplyUsdc(pricePerToken, tokens);
  try {
    await ledger.debit(caller, cost);
  } catch (err) {
    if (!(err instanceof InsufficientBalanceError)) throw err;
    // Overdraft tolerated: drain remaining balance and accept the response.
    await ledger.debit(caller, balance).catch(() => {});
  }
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

interface RespondResult {
  /** Token count detected. From agent.headers[X-Tokens-Used] for buffered; from
   *  SSE `usage.total_tokens` for streamed. 0 if not present. */
  tokens: number;
  streamed: boolean;
}

async function respondAndExtractTokens(
  res: Response,
  agent: AgentResponse,
): Promise<RespondResult> {
  res.status(agent.status ?? 200);
  if (agent.headers) {
    for (const [k, v] of Object.entries(agent.headers)) {
      res.setHeader(k, v);
    }
  }
  if (agent.stream) {
    if (!res.getHeader('content-type')) {
      res.setHeader('content-type', 'text/event-stream');
    }
    res.flushHeaders?.();
    const tokens = await pipeAndParseSse(res, agent.stream);
    res.end();
    return { tokens, streamed: true };
  }
  if (agent.body === undefined) {
    res.end();
  } else if (typeof agent.body === 'string') {
    res.send(agent.body);
  } else {
    res.json(agent.body);
  }
  return { tokens: readTokensUsed(agent), streamed: false };
}

/**
 * Pipe a web ReadableStream to the Express response while parsing OpenAI-format
 * Server-Sent Events for `usage.total_tokens`. Returns the last-seen token
 * count, or 0 if no `usage` payload was emitted by the upstream.
 *
 * Note: OpenAI streaming only emits `usage` when the client requests it via
 * `stream_options: { include_usage: true }`. Without that, per-token billing
 * on streamed responses will be 0 (call is effectively free).
 */
async function pipeAndParseSse(res: Response, stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let tokens = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(value);
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      // biome-ignore lint/suspicious/noAssignInExpressions: classic line-splitter
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '' || payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload) as { usage?: { total_tokens?: number } };
          if (typeof parsed.usage?.total_tokens === 'number') {
            tokens = parsed.usage.total_tokens;
          }
        } catch {
          // Non-JSON data line; ignore.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return tokens;
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
