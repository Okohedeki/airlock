/**
 * Pricing mode for a monetized Agent.
 *
 * - `flat`: caller pays a fixed `priceUsdc` per call. Fully implemented in v1.
 * - `per_token`: caller pre-funds a Credit Balance; per-call cost is
 *   `(tokens_used × pricePerTokenUsdc)` deducted after the handler returns
 *   based on the Agent's `X-Tokens-Used` response header. Ledger + interface
 *   shipped in v1; middleware runtime path lands in v1.1.
 */
export type PaymentMode = 'flat' | 'per_token';

/**
 * Identifier for a Caller. In v1 this is the EVM address recovered from the
 * x402 PaymentPayload signature.
 */
export type CallerId = `0x${string}`;

/**
 * Response header the publisher's Agent sets to report token usage for the
 * current request. Per-token mode only.
 */
export const TOKENS_USED_HEADER = 'X-Tokens-Used' as const;
