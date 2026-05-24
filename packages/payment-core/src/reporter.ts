/**
 * Reporter — fire-and-forget POST of every call's outcome to the airlock
 * backend's /api/inspect endpoint. The Publisher gets a token by running
 * `airlock login`, then `airlock sync` to register the project.
 *
 * Failures are swallowed — the reporter never blocks or breaks a paid call.
 */

import type { CallerId } from './types.js';

export interface CallReporter {
  /** Backend base URL, e.g. `http://localhost:8787`. */
  url: string;
  /** Bearer token issued via `airlock login`. */
  token: string;
  /** Project name registered with the backend (matches `airlock init`). */
  projectName: string;
  /** Override fetch for tests. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

export interface ReportableCall {
  caller: CallerId | null;
  status: number;
  request_url: string;
  tokens_used: number | null;
  /** USDC amount settled on-chain for this call; null for unpaid / session draws. */
  amount_usdc: string | null;
  payment_settled: boolean;
  /** Detected Agent Shape (e.g. 'openai', 'mcp', 'a2a', 'rest'). Optional. */
  shape?: string;
  /** What `tokens_used` counts, when not tokens (e.g. 'steps', 'items'). Optional. */
  unit_label?: string;
  /** Correlation id for tracing a single call across systems. Optional. */
  request_id?: string;
  /** On-chain settlement tx hash; null when settlement is deferred/pending. Optional. */
  settlement_tx?: string | null;
  /**
   * Schema version of this event. Lets a future tamper-evident / signed
   * audit-log reporter evolve the shape without breaking older consumers.
   */
  event_version?: number;
}

/**
 * Fire-and-forget report. Returns the underlying promise so tests can `await`
 * it; production callers should NOT await — the response should ship before
 * the report completes. Errors are caught and silently discarded.
 */
export function report(reporter: CallReporter, call: ReportableCall): Promise<void> {
  const fetchFn = reporter.fetchImpl ?? globalThis.fetch;
  return fetchFn(`${reporter.url.replace(/\/$/, '')}/api/inspect`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${reporter.token}`,
    },
    body: JSON.stringify({
      project_name: reporter.projectName,
      caller: call.caller,
      status: call.status,
      request_url: call.request_url,
      tokens_used: call.tokens_used,
      amount_usdc: call.amount_usdc,
      payment_settled: call.payment_settled,
      shape: call.shape,
      unit_label: call.unit_label,
      request_id: call.request_id,
      settlement_tx: call.settlement_tx,
      event_version: call.event_version,
    }),
  })
    .then(() => undefined)
    .catch(() => undefined);
}
