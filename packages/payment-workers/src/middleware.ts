import {
  buildPaymentRequired,
  type CallerId,
  type CallReporter,
  type CreditLedger,
  headerUsageExtractor,
  InMemoryCreditLedger,
  InsufficientBalanceError,
  type PaymentConfig,
  report,
  SESSION_HEADER,
  type UsageExtractor,
  type UsageReport,
} from '@airlockhq/payment-core';
import { decodePaymentSignatureHeader, encodePaymentResponseHeader } from '@x402/core/http';
import { HTTPFacilitatorClient } from '@x402/core/server';

/** Subset of FacilitatorClient we exercise — kept narrow so tests can stub easily. */
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

export interface WithPaymentOptions {
  /** Override the facilitator for tests / self-hosted setups. */
  facilitator?: PaymentFacilitator;
  /** Per-token mode only. Defaults to a per-process in-memory ledger — wire a
   * persistent impl (KV / D1 / Postgres) for production. */
  ledger?: CreditLedger;
  /** Optional fire-and-forget reporter — POSTs each call to the dashboard. */
  reporter?: CallReporter;
  /**
   * How to read billable units from the worker's response. Defaults to reading
   * the `X-Airlock-Units` / legacy `X-Tokens-Used` response headers. (Workers
   * handlers return a `Response`, so usage is reported via a header — set it on
   * the response your handler returns.)
   */
  usageExtractor?: UsageExtractor;
}

type FetchHandler<Env = unknown> = (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) => Response | Promise<Response>;

const PAYMENT_HEADER = 'X-PAYMENT';
const PAYMENT_RESPONSE_HEADER = 'X-PAYMENT-RESPONSE';

/**
 * Wrap a Cloudflare Workers fetch handler with x402 payment enforcement.
 *
 * **Flat mode**: every call requires X-PAYMENT; verify → handler → settle →
 * attach X-PAYMENT-RESPONSE.
 *
 * **Per-token mode**: first call requires X-PAYMENT to top up; settle credits
 * the Caller's balance in the ledger and we mint a session token returned in
 * X-Airlock-Session. Subsequent calls send that session token; we draw down
 * the balance by `(X-Tokens-Used × pricePerTokenUsdc)`. When balance drops
 * below `minCreditBalanceUsdc`, the next call returns 402 to top up again.
 */
export function withPayment<Env = unknown>(
  config: PaymentConfig,
  handler: FetchHandler<Env>,
  options: WithPaymentOptions = {},
): FetchHandler<Env> {
  const facilitator: PaymentFacilitator =
    options.facilitator ?? new HTTPFacilitatorClient({ url: config.facilitatorUrl });
  const ledger: CreditLedger = options.ledger ?? new InMemoryCreditLedger();
  const usageExtractor: UsageExtractor = options.usageExtractor ?? headerUsageExtractor();

  return async (request, env, ctx) => {
    if (!config.enabled) {
      return handler(request, env, ctx);
    }

    const required = buildPaymentRequired(config, request.url);
    const requirements = required.accepts[0];
    if (!requirements) {
      return json({ error: 'internal: no payment requirements built' }, { status: 500 });
    }

    const response =
      config.mode === 'per_token'
        ? await runPerToken(
            request,
            env,
            ctx,
            config,
            handler,
            facilitator,
            ledger,
            required,
            usageExtractor,
          )
        : await runFlat(request, env, ctx, handler, facilitator, required);

    if (options.reporter) {
      const settledHeader = response.headers.get(PAYMENT_RESPONSE_HEADER);
      const usage = usageFromResponse(response, usageExtractor);
      const amount_usdc =
        settledHeader !== null
          ? config.mode === 'flat'
            ? config.priceUsdc
            : config.minCreditBalanceUsdc
          : null;
      // Fire-and-forget; do NOT await — reports lag the response.
      report(options.reporter, {
        caller: callerFromResponse(response, settledHeader),
        status: response.status,
        request_url: request.url,
        tokens_used: usage?.units ?? null,
        amount_usdc,
        payment_settled: settledHeader !== null,
        unit_label: usage?.unitLabel,
        event_version: 1,
      });
    }

    return response;
  };
}

/** Read billable units from a worker Response via the configured extractor. */
function usageFromResponse(response: Response, extractor: UsageExtractor): UsageReport | null {
  const agentHeaders: Record<string, string> = {};
  response.headers.forEach((v, k) => {
    agentHeaders[k] = v;
  });
  return extractor({ agentHeaders });
}

function callerFromResponse(_response: Response, settledHeader: string | null): CallerId | null {
  if (!settledHeader) return null;
  try {
    const decoded = JSON.parse(atob(settledHeader)) as { payer?: string };
    return (decoded.payer as CallerId | undefined) ?? null;
  } catch {
    return null;
  }
}

async function runFlat<Env>(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  handler: FetchHandler<Env>,
  facilitator: PaymentFacilitator,
  required: ReturnType<typeof buildPaymentRequired>,
): Promise<Response> {
  const requirements = required.accepts[0];
  if (!requirements) return json({ error: 'internal' }, { status: 500 });

  const header = request.headers.get(PAYMENT_HEADER);
  if (!header) return json(required, { status: 402 });

  let payload: unknown;
  try {
    payload = decodePaymentSignatureHeader(header);
  } catch {
    return json({ ...required, error: 'malformed X-PAYMENT header' }, { status: 402 });
  }

  const verify = await facilitator.verify(payload, requirements);
  if (!verify.isValid) {
    return json(
      { ...required, error: verify.invalidReason ?? 'payment verification failed' },
      { status: 402 },
    );
  }

  const response = await handler(request, env, ctx);

  const settle = await facilitator.settle(payload, requirements);
  if (!settle.success) {
    return json({ ...required, error: settle.errorReason ?? 'settlement failed' }, { status: 402 });
  }

  return attachSettlement(response, settle);
}

async function runPerToken<Env>(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  config: PaymentConfig & { mode: 'per_token' },
  handler: FetchHandler<Env>,
  facilitator: PaymentFacilitator,
  ledger: CreditLedger,
  required: ReturnType<typeof buildPaymentRequired>,
  usageExtractor: UsageExtractor,
): Promise<Response> {
  const requirements = required.accepts[0];
  if (!requirements) return json({ error: 'internal' }, { status: 500 });

  const sessionHeader = request.headers.get(SESSION_HEADER);
  const paymentHeader = request.headers.get(PAYMENT_HEADER);

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
      return json({ ...required, error: 'invalid or expired session' }, { status: 402 });
    }
  } else if (paymentHeader) {
    // Topup path: verify + settle, credit balance, mint session
    let payload: unknown;
    try {
      payload = decodePaymentSignatureHeader(paymentHeader);
    } catch {
      return json({ ...required, error: 'malformed X-PAYMENT header' }, { status: 402 });
    }
    const verify = await facilitator.verify(payload, requirements);
    if (!verify.isValid) {
      return json(
        { ...required, error: verify.invalidReason ?? 'payment verification failed' },
        { status: 402 },
      );
    }
    settleResult = await facilitator.settle(payload, requirements);
    if (!settleResult.success) {
      return json(
        { ...required, error: settleResult.errorReason ?? 'settlement failed' },
        { status: 402 },
      );
    }
    const payer = settleResult.payer ?? verify.payer;
    if (!payer) {
      return json({ ...required, error: 'facilitator did not return payer' }, { status: 500 });
    }
    caller = payer as CallerId;
    await ledger.credit(caller, config.minCreditBalanceUsdc);
  } else {
    return json(required, { status: 402 });
  }

  // Per-call balance gate: must have any positive balance to proceed.
  // minCreditBalanceUsdc is the *topup* amount, not a per-call required floor.
  const balance = await ledger.getBalance(caller);
  if (compareUsdc(balance, '0') <= 0) {
    return json({ ...required, error: 'credit balance depleted; top up' }, { status: 402 });
  }

  const response = await handler(request, env, ctx);

  // Read tokens used from the agent's response and debit. If the actual debit
  // would overflow the remaining balance, we log it as an overdraft (v1
  // accepts a single-call overrun rather than refusing to return the response
  // the publisher already computed). Future versions can pre-gate using an
  // `expectedMaxTokens` config knob.
  const tokens = usageFromResponse(response, usageExtractor)?.units ?? 0;
  if (tokens > 0) {
    const cost = multiplyUsdc(config.pricePerTokenUsdc, tokens);
    try {
      await ledger.debit(caller, cost);
    } catch (err) {
      if (!(err instanceof InsufficientBalanceError)) throw err;
      // Overdraft: clear what we can and let this call through.
      await ledger.debit(caller, balance).catch(() => {});
    }
  }

  // Issue / refresh the session header on every successful call
  const issuedSession = sessionHeader ?? (await ledger.issueSession(caller));
  const finalResponse = new Response(response.body, response);
  finalResponse.headers.set(SESSION_HEADER, issuedSession);
  if (settleResult) {
    finalResponse.headers.set(
      PAYMENT_RESPONSE_HEADER,
      encodePaymentResponseHeader(
        settleResult as Parameters<typeof encodePaymentResponseHeader>[0],
      ),
    );
  }
  return finalResponse;
}

function attachSettlement(
  response: Response,
  settle: { success: boolean; transaction?: string; network?: string; payer?: string },
): Response {
  const out = new Response(response.body, response);
  out.headers.set(
    PAYMENT_RESPONSE_HEADER,
    encodePaymentResponseHeader(settle as Parameters<typeof encodePaymentResponseHeader>[0]),
  );
  return out;
}

function json(body: unknown, init: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

/** Compare two USDC decimal strings: -1 / 0 / 1. */
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
