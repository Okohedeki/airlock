import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { type AirlockConfig, type Target, writeConfig } from '../config-file.js';
import { scanRepo } from '../scan.js';
import { type AgentHarness, flyAgentStarter } from '../templates/fly-agent.js';
import { flyNodeStarter } from '../templates/fly-node.js';
import { workersStarter } from '../templates/workers.js';

export interface InitOptions {
  cwd: string;
  name: string;
  target: Target;
  /** Write a starter Recipe config (`wrangler.toml` or `fly.toml`) alongside ours. */
  scaffoldRecipe?: boolean;
  /** Also scaffold a runnable starter agent (entry point, Dockerfile, deps). */
  withAgent?: boolean;
  /** Scaffold a harness-backed agentic service (implies an agent; Fly-only). */
  harness?: AgentHarness;
  /** Scan an existing repo, detect the harness + entrypoint, and write [agent]. */
  detect?: boolean;
}

export interface InitResult {
  configPath: string;
  recipePath?: string;
  /** Paths of starter-agent files written when `withAgent` is set. */
  agentPaths?: string[];
  /** Detection result + files written when `detect` is set. */
  detected?: { harness?: string; entrypoint?: string; evidence: string[] };
  detectPaths?: string[];
}

const RUNTIME_DOCKERFILE = `FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV PORT=3000
EXPOSE 3000
# Config-driven: reads .airlock/config.toml [agent] and drives your harness.
# Model is publisher-supplied — set OPENAI_API_BASE / OPENAI_API_KEY (ADR-0008).
CMD ["python", "-m", "airlock_agent"]
`;

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
  # Keep one machine warm to avoid cold-start latency on the first paid call.
  # Set to 0 to scale to zero (cheaper, but adds cold-start latency).
  min_machines_running = 1
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

  // Detect mode: scan an existing repo and bind its harness via the [agent] block.
  let detected: InitResult['detected'];
  let detectPaths: string[] | undefined;
  if (opts.detect) {
    const scan = await scanRepo(opts.cwd);
    detected = scan;
    config.agent = {
      harness: scan.harness ?? 'custom',
      entrypoint: scan.entrypoint ?? 'CHANGE_ME:your_agent',
    };
    detectPaths = [];
    // Dockerfile that runs the config-driven runtime (no app.py).
    const dockerfile = resolve(opts.cwd, 'Dockerfile');
    await writeFile(dockerfile, RUNTIME_DOCKERFILE, 'utf8');
    detectPaths.push(dockerfile);
    // Ensure airlock-agent is a dependency.
    const reqPath = resolve(opts.cwd, 'requirements.txt');
    const existing = await readFile(reqPath, 'utf8').catch(() => '');
    if (!/^airlock-agent\b/m.test(existing)) {
      await writeFile(reqPath, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}airlock-agent\n`, 'utf8');
      detectPaths.push(reqPath);
    }
  }

  const configPath = await writeConfig(opts.cwd, config);

  let recipePath: string | undefined;
  if (opts.scaffoldRecipe !== false) {
    const recipeName = opts.target === 'workers' ? 'wrangler.toml' : 'fly.toml';
    recipePath = resolve(opts.cwd, recipeName);
    const recipeContent =
      opts.target === 'workers' ? WRANGLER_STARTER(opts.name) : FLY_STARTER(opts.name);
    await writeFile(recipePath, recipeContent, 'utf8');
  }

  if (opts.harness && opts.target !== 'fly') {
    throw new Error(`--agent=${opts.harness} requires --target=fly (Python harnesses run on Fly)`);
  }

  let agentPaths: string[] | undefined;
  if (opts.harness || opts.withAgent) {
    const files = opts.harness
      ? flyAgentStarter(opts.name, opts.harness)
      : opts.target === 'workers'
        ? workersStarter(opts.name)
        : flyNodeStarter(opts.name);
    agentPaths = [];
    for (const file of files) {
      const dest = resolve(opts.cwd, file.path);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, file.content, 'utf8');
      agentPaths.push(dest);
    }
  }

  return { configPath, recipePath, agentPaths, detected, detectPaths };
}
