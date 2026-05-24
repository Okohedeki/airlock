/**
 * Starter files for a harness-agnostic Node/Express agent on the Fly Recipe.
 * Emitted by `airlock init --with-agent --target=fly`. The agent mounts the
 * payment middleware IN-PROCESS on its own route — no model, no proxy. The
 * publisher replaces the handler body with their agent logic.
 */

export interface TemplateFile {
  /** Path relative to the project root. */
  path: string;
  content: string;
}

export function flyNodeStarter(name: string): TemplateFile[] {
  return [
    {
      path: 'src/server.ts',
      content: `import { withPaymentExpress } from '@airlockhq/payment-fly-node';
import express from 'express';
import { paymentConfig, PORT } from './config.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Your agent. Mounted in-process — airlock never sits in this request path.
app.post(
  '/run',
  withPaymentExpress(paymentConfig, async (req) => {
    // TODO: replace with your agent logic (tool loop, LangGraph, CrewAI, …).
    const input = req.body as unknown;
    const result = { echo: input };

    // Report billable units for per-token mode (tokens, steps, items…).
    // Flat mode ignores this; omit \`usage\` entirely if you bill per call.
    return { status: 200, body: result, usage: { units: 1, unitLabel: 'calls' } };
  }),
);

app.listen(PORT, () => {
  console.log(\`${name} listening on http://localhost:\${PORT}  (POST /run)\`);
});
`,
    },
    {
      path: 'src/config.ts',
      content: `import type { PaymentConfig } from '@airlockhq/payment-core';
import { PaymentConfigSchema } from '@airlockhq/payment-core';

const env = process.env;

export const PORT = Number(env.PORT ?? 3000);

// Defaults to payment OFF so the agent runs with no crypto setup. Flip on with
// PAYMENT_ENABLED=1 and set PUBLISHER_WALLET to your address.
export const paymentConfig: PaymentConfig = PaymentConfigSchema.parse({
  enabled: env.PAYMENT_ENABLED === '1',
  wallet: env.PUBLISHER_WALLET ?? '0x0000000000000000000000000000000000000001',
  network: env.PAYMENT_NETWORK ?? 'base-sepolia',
  description: 'Call this agent',
  mode: 'flat',
  priceUsdc: env.PRICE_USDC ?? '0.001',
});
`,
    },
    {
      path: 'package.json',
      content: `${JSON.stringify(
        {
          name,
          version: '0.0.0',
          private: true,
          type: 'module',
          scripts: {
            dev: 'tsx watch src/server.ts',
            start: 'node --import=tsx src/server.ts',
          },
          dependencies: {
            '@airlockhq/payment-core': '^0.0.0',
            '@airlockhq/payment-fly-node': '^0.0.0',
            express: '^5.0.0',
          },
          devDependencies: {
            '@types/express': '^5.0.0',
            '@types/node': '^22.10.0',
            tsx: '^4.19.0',
            typescript: '^5.7.0',
          },
        },
        null,
        2,
      )}\n`,
    },
    {
      path: 'Dockerfile',
      content: `FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
ENV PORT=3000
EXPOSE 3000
CMD ["npx", "-y", "tsx", "src/server.ts"]
`,
    },
    {
      path: 'tsconfig.json',
      content: `${JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            types: ['node'],
          },
          include: ['src/**/*'],
        },
        null,
        2,
      )}\n`,
    },
  ];
}
