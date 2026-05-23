import { z } from 'zod';

/**
 * USDC contract addresses on supported networks. Used as the default `asset`
 * when the publisher does not pin one explicitly.
 */
/**
 * USDC contract addresses keyed by x402 v1 network identifiers
 * (see `@x402/evm` EVM_NETWORK_CHAIN_ID_MAP). Keep the keys in sync — the
 * client picks a scheme by matching the network string in PaymentRequirements.
 */
export const USDC_ADDRESSES = {
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
} as const satisfies Record<string, `0x${string}`>;

export type SupportedNetwork = keyof typeof USDC_ADDRESSES;

const EvmAddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'must be a 0x-prefixed 40-char hex EVM address')
  .transform((s) => s as `0x${string}`);

const NonNegativeNumberString = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'must be a non-negative decimal string')
  .refine((s) => Number.parseFloat(s) >= 0, 'must be ≥ 0');

const FlatConfigSchema = z.object({
  mode: z.literal('flat'),
  priceUsdc: NonNegativeNumberString.describe('USDC charged per call (e.g. "0.01")'),
});

const PerTokenConfigSchema = z.object({
  mode: z.literal('per_token'),
  pricePerTokenUsdc: NonNegativeNumberString.describe('USDC charged per reported token'),
  minCreditBalanceUsdc: NonNegativeNumberString.describe(
    'minimum balance below which the next call returns 402',
  ),
});

/**
 * `[payment]` section of `.airlock-deploy/config.toml`. Validated via Zod so
 * misconfigurations fail at `airlock-deploy doctor`, not at first paid call.
 */
export const PaymentConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    wallet: EvmAddressSchema.describe("publisher's wallet that receives payments"),
    network: z
      .enum(Object.keys(USDC_ADDRESSES) as [SupportedNetwork, ...SupportedNetwork[]])
      .default('base'),
    asset: EvmAddressSchema.optional().describe('asset contract; defaults to USDC for the network'),
    facilitatorUrl: z
      .string()
      .url()
      .default('https://facilitator.x402.org')
      .describe('x402 facilitator; default is the public Coinbase one'),
    description: z
      .string()
      .max(200)
      .default('Payment required to call this Agent')
      .describe('shown to Callers in the 402 response'),
  })
  .and(z.union([FlatConfigSchema, PerTokenConfigSchema]));

export type PaymentConfig = z.infer<typeof PaymentConfigSchema>;

/**
 * Resolves the asset address to use for a config: explicit `asset` wins,
 * otherwise the network's canonical USDC address.
 */
export function resolveAsset(config: PaymentConfig): `0x${string}` {
  return config.asset ?? USDC_ADDRESSES[config.network];
}
