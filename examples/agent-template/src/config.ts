import type { PaymentConfig } from '@airlockhq/payment-core';
import { PaymentConfigSchema } from '@airlockhq/payment-core';

const env = process.env;

/** Port the agent listens on. Fly/Workers set PORT. */
export const PORT = Number(env.PORT ?? 3000);

/**
 * Optional model dependency. The agent works with NO model at all; if these are
 * set it will also summarize the fetched page via any OpenAI-compatible API.
 * This proves the model is just an optional dependency, not the deployed unit.
 */
export const OPENAI_API_KEY = env.OPENAI_API_KEY;
export const OPENAI_BASE_URL = env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
export const OPENAI_MODEL = env.OPENAI_MODEL ?? 'gpt-4o-mini';

/**
 * Payment config. Defaults `enabled: false` so the template runs out of the box
 * with no crypto setup. Flip on with PAYMENT_ENABLED=1 + PUBLISHER_WALLET.
 *
 * Per-token mode bills by the `units` the handler reports (here: words read) —
 * showing that metered billing is not LLM-specific.
 */
export const paymentConfig: PaymentConfig = PaymentConfigSchema.parse({
  enabled: env.PAYMENT_ENABLED === '1',
  wallet:
    env.PUBLISHER_WALLET ??
    // placeholder — replaced when the publisher sets PUBLISHER_WALLET
    '0x0000000000000000000000000000000000000001',
  network: env.PAYMENT_NETWORK ?? 'base-sepolia',
  facilitatorUrl: env.FACILITATOR_URL ?? 'https://facilitator.x402.org',
  description: 'Analyze a web page',
  ...(env.PAYMENT_MODE === 'per_token'
    ? {
        mode: 'per_token' as const,
        pricePerTokenUsdc: env.PRICE_PER_UNIT_USDC ?? '0.0000001',
        minCreditBalanceUsdc: env.MIN_CREDIT_USDC ?? '0.10',
      }
    : { mode: 'flat' as const, priceUsdc: env.PRICE_USDC ?? '0.001' }),
});
