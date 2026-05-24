import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type AirlockConfig, type Target, writeConfig } from '../config-file.js';

export interface InitOptions {
  cwd: string;
  name: string;
  target: Target;
  /** Write a starter Recipe config (`wrangler.toml` or `fly.toml`) alongside ours. */
  scaffoldRecipe?: boolean;
}

export interface InitResult {
  configPath: string;
  recipePath?: string;
}

const WRANGLER_STARTER = (name: string) => `name = "${name}"
main = "src/index.ts"
compatibility_date = "2025-10-01"

# secrets: \`wrangler secret put OPENAI_API_KEY\`
# custom domain: \`wrangler deploy --routes …\`
`;

const FLY_STARTER = (name: string) => `app = "${name}"
primary_region = "iad"

[build]

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0
`;

const PAYMENT_SCAFFOLD = {
  enabled: false,
  // placeholder — replace with the publisher's wallet before enabling
  wallet: '0x0000000000000000000000000000000000000001',
  network: 'base-sepolia',
  facilitatorUrl: 'https://facilitator.x402.org',
  description: 'Call this Agent',
  mode: 'flat',
  priceUsdc: '0.001',
};

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const config: AirlockConfig = {
    project: { name: opts.name, target: opts.target, schemaVersion: 1 },
    payment: PAYMENT_SCAFFOLD,
  };
  const configPath = await writeConfig(opts.cwd, config);

  let recipePath: string | undefined;
  if (opts.scaffoldRecipe !== false) {
    const recipeName = opts.target === 'workers' ? 'wrangler.toml' : 'fly.toml';
    recipePath = resolve(opts.cwd, recipeName);
    const recipeContent =
      opts.target === 'workers' ? WRANGLER_STARTER(opts.name) : FLY_STARTER(opts.name);
    await writeFile(recipePath, recipeContent, 'utf8');
  }

  return { configPath, recipePath };
}
