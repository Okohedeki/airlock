import type { PaymentConfig } from '@airlock-deploy/payment-core';
import { PaymentConfigSchema } from '@airlock-deploy/payment-core';

const env = process.env;

/** PORT the Express server listens on. */
export const PORT = Number(env.PORT ?? 3000);

/** Where Ollama (or any OpenAI-compatible /api/chat endpoint) is listening. */
export const OLLAMA_URL = env.OLLAMA_URL ?? 'http://localhost:11434';

/** Default model. Override with MODEL=. `llama3.2:1b` is a good small default. */
export const MODEL = env.MODEL ?? 'llama3.2:1b';

/**
 * Payment config. Defaults `enabled: false` so the demo works out of the box
 * without crypto setup — set PAYMENT_ENABLED=1 and PUBLISHER_WALLET to flip it on.
 */
export const paymentConfig: PaymentConfig = PaymentConfigSchema.parse({
  enabled: env.PAYMENT_ENABLED === '1',
  wallet:
    env.PUBLISHER_WALLET ??
    // placeholder — replaced when the publisher sets PUBLISHER_WALLET
    '0x0000000000000000000000000000000000000001',
  network: env.PAYMENT_NETWORK ?? 'base-sepolia',
  facilitatorUrl: env.FACILITATOR_URL ?? 'https://facilitator.x402.org',
  description: `Call the local LLM (${MODEL})`,
  mode: 'flat',
  priceUsdc: env.PRICE_USDC ?? '0.001',
});
