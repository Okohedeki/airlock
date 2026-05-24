/**
 * Starter files for a harness-agnostic Cloudflare Workers agent.
 * Emitted by `airlock init --with-agent --target=workers`. Mounts the payment
 * middleware in-process around the fetch handler. Stateless/edge — for stateful
 * or Python agents use the Fly Recipe instead.
 */

import type { TemplateFile } from './fly-node.js';

export function workersStarter(name: string): TemplateFile[] {
  return [
    {
      path: 'src/index.ts',
      content: `import { PaymentConfigSchema } from '@airlockhq/payment-core';
import { withPayment } from '@airlockhq/payment-workers';

const paymentConfig = PaymentConfigSchema.parse({
  enabled: true,
  // TODO: set your wallet address.
  wallet: '0x0000000000000000000000000000000000000001',
  network: 'base-sepolia',
  mode: 'flat',
  priceUsdc: '0.001',
});

// Your agent. Mounted in-process around the fetch handler.
const handler = async (request: Request): Promise<Response> => {
  // TODO: replace with your agent logic.
  const input = await request.json().catch(() => ({}));
  return new Response(JSON.stringify({ echo: input }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      // Report billable units for per-token mode (omit for flat per-call).
      'X-Airlock-Units': '1',
    },
  });
};

export default { fetch: withPayment(paymentConfig, handler) };
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
            dev: 'wrangler dev',
            deploy: 'wrangler deploy',
          },
          dependencies: {
            '@airlockhq/payment-core': '^0.0.0',
            '@airlockhq/payment-workers': '^0.0.0',
          },
          devDependencies: {
            '@cloudflare/workers-types': '^4.0.0',
            typescript: '^5.7.0',
            wrangler: '^3.0.0',
          },
        },
        null,
        2,
      )}\n`,
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
            skipLibCheck: true,
            types: ['@cloudflare/workers-types'],
          },
          include: ['src/**/*'],
        },
        null,
        2,
      )}\n`,
    },
  ];
}
