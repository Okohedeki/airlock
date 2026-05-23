import type { PaymentConfig } from './config.js';
import { resolveAsset } from './config.js';

/**
 * The subset of x402 v1 PaymentRequirements we construct from a PaymentConfig.
 * Mirrors `@x402/core` schemas but kept local so we don't lock callers to a
 * specific x402 version at the type-export level.
 */
export interface PaymentRequirements {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  payTo: `0x${string}`;
  maxTimeoutSeconds: number;
  asset: `0x${string}`;
  extra?: Record<string, unknown>;
}

export interface PaymentRequired {
  x402Version: 1;
  accepts: PaymentRequirements[];
  error?: string;
}

const DEFAULT_TIMEOUT_SECONDS = 60;

/**
 * The on-wire `maxAmountRequired` is an integer in the asset's smallest unit.
 * USDC has 6 decimals on Base, so "0.01" USDC → 10_000.
 */
function usdcToAtomic(usdc: string): string {
  const [whole, frac = ''] = usdc.split('.');
  const fracPadded = `${frac}000000`.slice(0, 6);
  const combined = `${whole}${fracPadded}`.replace(/^0+(?=\d)/, '');
  return combined === '' ? '0' : combined;
}

/**
 * Build a PaymentRequired (HTTP 402 body) from the publisher's PaymentConfig
 * for a given resource URL.
 *
 * For `flat` mode, the amount is the per-call price.
 *
 * For `per_token` mode, the amount is the minimum credit-balance top-up — the
 * first 402 in per-token mode is a one-time funding request, not a per-call
 * charge.
 */
export function buildPaymentRequired(config: PaymentConfig, resource: string): PaymentRequired {
  const amountUsdc = config.mode === 'flat' ? config.priceUsdc : config.minCreditBalanceUsdc;

  const requirements: PaymentRequirements = {
    scheme: 'exact',
    network: config.network,
    maxAmountRequired: usdcToAtomic(amountUsdc),
    resource,
    description: config.description,
    payTo: config.wallet,
    maxTimeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    asset: resolveAsset(config),
    extra: config.mode === 'per_token' ? { mode: 'per_token_topup' } : undefined,
  };

  return {
    x402Version: 1,
    accepts: [requirements],
    ...(config.mode === 'per_token'
      ? { error: 'credit balance below minimum; pay to top up' }
      : {}),
  };
}

/** Test-visible export for atomic-unit conversion. */
export const _internal = { usdcToAtomic };
