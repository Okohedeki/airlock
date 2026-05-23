import { buildPaymentRequired, type PaymentConfig } from '@airlock-deploy/payment-core';
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
  /** Override the facilitator for testing or a self-hosted setup. */
  facilitator?: PaymentFacilitator;
}

/**
 * Async handler shape. The Publisher's handler returns a structured response;
 * we serialize and write to `res` ourselves so we can attach the
 * `X-PAYMENT-RESPONSE` header after settlement.
 */
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
 * x402 payment per call. Mirrors `withPayment` in `@airlock-deploy/payment-workers`
 * — same config, same flow, framework-adapted.
 *
 * Per-token mode returns 501 until v1.1 (see ADR-0005).
 */
export function withPaymentExpress(
  config: PaymentConfig,
  handler: AgentHandler,
  options: WithPaymentExpressOptions = {},
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const facilitator: PaymentFacilitator =
    options.facilitator ?? new HTTPFacilitatorClient({ url: config.facilitatorUrl });

  return async (req, res, next) => {
    try {
      if (!config.enabled) {
        await respond(res, await handler(req));
        return;
      }

      if (config.mode === 'per_token') {
        res.status(501).json({ error: 'per_token mode is not implemented in v1 (see ADR-0005)' });
        return;
      }

      const resource = absoluteUrl(req);
      const required = buildPaymentRequired(config, resource);
      const requirements = required.accepts[0];
      if (!requirements) {
        res.status(500).json({ error: 'internal: no payment requirements built' });
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

      const verifyResult = await facilitator.verify(payload, requirements);
      if (!verifyResult.isValid) {
        res.status(402).json({
          ...required,
          error: verifyResult.invalidReason ?? 'payment verification failed',
        });
        return;
      }

      const agentResponse = await handler(req);

      const settleResult = await facilitator.settle(payload, requirements);
      if (!settleResult.success) {
        res
          .status(402)
          .json({ ...required, error: settleResult.errorReason ?? 'settlement failed' });
        return;
      }

      res.setHeader(
        PAYMENT_RESPONSE_HEADER,
        encodePaymentResponseHeader(
          settleResult as Parameters<typeof encodePaymentResponseHeader>[0],
        ),
      );
      await respond(res, agentResponse);
    } catch (err) {
      next(err);
    }
  };
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
