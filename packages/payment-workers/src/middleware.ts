import { buildPaymentRequired, type PaymentConfig } from '@airlock-deploy/payment-core';
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
  /** Override the facilitator for testing / self-hosted setups. Defaults to one built from `config.facilitatorUrl`. */
  facilitator?: PaymentFacilitator;
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
 * Flow per request when `config.enabled`:
 *   1. No `X-PAYMENT` header → return 402 with PaymentRequired body
 *   2. Header present → verify via Facilitator
 *   3. Verify fails → return 402 with the same PaymentRequired body
 *   4. Verify passes → call the wrapped handler
 *   5. Settle via Facilitator and attach `X-PAYMENT-RESPONSE` header to the response
 *
 * Per-token mode is rejected at the middleware boundary in v1 — the credit
 * ledger interface ships in payment-core but the per-call deduction flow lands
 * in v1.1. See `docs/adr/0005-x402-for-monetization.md`.
 */
export function withPayment<Env = unknown>(
  config: PaymentConfig,
  handler: FetchHandler<Env>,
  options: WithPaymentOptions = {},
): FetchHandler<Env> {
  const facilitator: PaymentFacilitator =
    options.facilitator ?? new HTTPFacilitatorClient({ url: config.facilitatorUrl });

  return async (request, env, ctx) => {
    if (!config.enabled) {
      return handler(request, env, ctx);
    }

    if (config.mode === 'per_token') {
      return json(
        { error: 'per_token mode is not implemented in v1 (see ADR-0005)' },
        { status: 501 },
      );
    }

    const required = buildPaymentRequired(config, request.url);
    const requirements = required.accepts[0];
    if (!requirements) {
      // unreachable: buildPaymentRequired always emits one entry
      return json({ error: 'internal: no payment requirements built' }, { status: 500 });
    }

    const header = request.headers.get(PAYMENT_HEADER);
    if (!header) {
      return json(required, { status: 402 });
    }

    let payload: unknown;
    try {
      payload = decodePaymentSignatureHeader(header);
    } catch {
      return json({ ...required, error: 'malformed X-PAYMENT header' }, { status: 402 });
    }

    const verifyResult = await facilitator.verify(payload, requirements);
    if (!verifyResult.isValid) {
      return json(
        { ...required, error: verifyResult.invalidReason ?? 'payment verification failed' },
        { status: 402 },
      );
    }

    const response = await handler(request, env, ctx);

    const settleResult = await facilitator.settle(payload, requirements);
    if (!settleResult.success) {
      return json(
        { ...required, error: settleResult.errorReason ?? 'settlement failed' },
        { status: 402 },
      );
    }

    const responseWithSettlement = new Response(response.body, response);
    responseWithSettlement.headers.set(
      PAYMENT_RESPONSE_HEADER,
      encodePaymentResponseHeader(
        settleResult as Parameters<typeof encodePaymentResponseHeader>[0],
      ),
    );
    return responseWithSettlement;
  };
}

function json(body: unknown, init: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}
