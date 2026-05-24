/**
 * Usage reporting — transport-neutral, harness-agnostic.
 *
 * Per-token billing originally read OpenAI's `usage.total_tokens`. But airlock
 * wraps *any* agent harness (MCP servers, tool loops, plain REST), so "tokens"
 * is generalized to billable **units**: tokens, reasoning steps, tool-calls,
 * rows returned — whatever the Agent meters. The Agent reports a unit count;
 * how that count maps to USDC is the pricing config's job, not ours.
 *
 * An Agent reports usage one of three ways (preferred → fallback):
 *   1. the in-process handler returns `AgentResponse.usage` directly,
 *   2. it sets the {@link USAGE_UNITS_HEADER} (or legacy `X-Tokens-Used`) header,
 *   3. a publisher-supplied {@link UsageExtractor} derives it from the response.
 *
 * Flat per-call pricing needs none of this — use {@link nullUsageExtractor}.
 */

import { TOKENS_USED_HEADER, USAGE_UNITS_HEADER } from './types.js';

export interface UsageReport {
  /** Billable units consumed by this request. Non-negative. */
  units: number;
  /** What the units represent (e.g. 'tokens', 'steps', 'items'). Informational. */
  unitLabel?: string;
}

/** What an extractor inspects: the Agent's response headers and/or parsed body. */
export interface UsageContext {
  agentHeaders?: Record<string, string>;
  agentBody?: unknown;
}

/** Derives a {@link UsageReport} from an Agent response, or null if none found. */
export type UsageExtractor = (ctx: UsageContext) => UsageReport | null;

function lookupHeader(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return v;
  }
  return undefined;
}

function parsePositiveInt(raw: string | undefined): number | null {
  if (raw == null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Default extractor. Reads the generic {@link USAGE_UNITS_HEADER} first, then
 * falls back to the legacy `X-Tokens-Used` header. Pass an explicit header name
 * to read only that one.
 */
export function headerUsageExtractor(header?: string): UsageExtractor {
  return ({ agentHeaders }) => {
    if (header) {
      const n = parsePositiveInt(lookupHeader(agentHeaders, header));
      return n == null ? null : { units: n };
    }
    const units = parsePositiveInt(lookupHeader(agentHeaders, USAGE_UNITS_HEADER));
    if (units != null) return { units };
    const tokens = parsePositiveInt(lookupHeader(agentHeaders, TOKENS_USED_HEADER));
    if (tokens != null) return { units: tokens, unitLabel: 'tokens' };
    return null;
  };
}

/**
 * Opt-in extractor for OpenAI-shaped responses — reads `usage.total_tokens`
 * from the (buffered) response body. Use when fronting an OpenAI-compatible
 * upstream that doesn't set a usage header itself.
 */
export function openAiUsageExtractor(): UsageExtractor {
  return ({ agentBody }) => {
    if (agentBody == null || typeof agentBody !== 'object') return null;
    const usage = (agentBody as { usage?: { total_tokens?: unknown } }).usage;
    const total = usage?.total_tokens;
    return typeof total === 'number' && Number.isFinite(total) && total > 0
      ? { units: total, unitLabel: 'tokens' }
      : null;
  };
}

/** No usage. The flat-per-call path: every call costs the same, nothing metered. */
export function nullUsageExtractor(): UsageExtractor {
  return () => null;
}
