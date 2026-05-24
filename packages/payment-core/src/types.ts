/**
 * Pricing mode for a monetized Agent.
 *
 * - `flat`: caller pays a fixed `priceUsdc` per call. Native x402.
 * - `per_token`: caller pays once via x402 to top up a Credit Balance, then
 *   subsequent calls draw down via a session token returned in
 *   `X-Airlock-Session`. Per-call cost is `(tokens_used × pricePerTokenUsdc)`
 *   read from the Agent's `X-Tokens-Used` response header.
 */
export type PaymentMode = 'flat' | 'per_token';

/**
 * Identifier for a Caller. In v1 this is the EVM address recovered from the
 * x402 PaymentPayload signature by the Facilitator (returned as `payer`).
 */
export type CallerId = `0x${string}`;

/**
 * Response header the publisher's Agent sets to report token usage for the
 * current request. Per-token mode only.
 */
export const TOKENS_USED_HEADER = 'X-Tokens-Used' as const;

/**
 * Response header carrying the opaque per-Caller session token issued after a
 * successful x402 top-up. Callers send this header on subsequent calls to draw
 * down their Credit Balance without re-paying.
 */
export const SESSION_HEADER = 'X-Airlock-Session' as const;
