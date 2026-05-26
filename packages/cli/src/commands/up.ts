/**
 * `airlock up` — run a self-hosted agent on the publisher's OWN hardware and
 * front it with a public URL. This is the self-host production path: the agent
 * loop (`python -m airlock_agent`) runs here, payment is enforced in-process,
 * and airlock only operates the tunnel that exposes it — never the compute,
 * never the model (which may be local or a remote OPENAI_API_BASE).
 *
 * Step 1a uses the bundled Cloudflare quick tunnel (ephemeral URL). The durable
 * `<name>.airlock.dev` named-tunnel path (step 1b) layers on top via a token the
 * backend mints; see startNamedTunnel.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { PaymentConfigSchema } from '@airlockhq/payment-core';
import { type AirlockConfig, readConfig } from '../config-file.js';
import { startTunnel, type TunnelHandle } from '../tunnel.js';

export interface UpOptions {
  cwd?: string;
  /** Port the agent listens on (and we tunnel to). */
  port?: number;
  /** Python executable to run `-m airlock_agent` with (respects an active venv). */
  python?: string;
  /** Disable payment enforcement on the agent. */
  noPayment?: boolean;
  /** Run the agent locally but don't open a public tunnel. */
  noTunnel?: boolean;
  /** Max agent runs in flight at once before callers queue (AIRLOCK_MAX_CONCURRENCY). */
  maxConcurrency?: number;
  /** Max callers waiting beyond the running set before new ones get 429 (AIRLOCK_MAX_QUEUE). */
  maxQueue?: number;
  /** Seconds a caller waits in the queue before a 429 (AIRLOCK_QUEUE_TIMEOUT_S). */
  queueTimeout?: number;
  /** Force per-call agent rebuild on/off (AIRLOCK_BUILD_PER_CALL); default inferred at runtime. */
  buildPerCall?: boolean;
  /** Injectables for tests. */
  spawnImpl?: typeof spawn;
  startTunnelImpl?: typeof startTunnel;
  fetchImpl?: typeof fetch;
}

export interface UpPlan {
  python: string;
  args: string[];
  port: number;
  /** Env overlay handed to the agent process (merged over process.env at spawn). */
  env: Record<string, string>;
}

/**
 * Translate config + options into a concrete launch plan. Pure + testable:
 * maps the `[payment]` block into the env vars `python -m airlock_agent` reads
 * (PAYMENT_ENABLED / PUBLISHER_WALLET / PAYMENT_NETWORK / PRICE_USDC, see the
 * runtime's serve.config_from_env). Throws if there's no `[agent]` block — `up`
 * runs a config-bound harness; to wrap a bare model, use `airlock serve`.
 */
export function resolveUpPlan(config: AirlockConfig, opts: UpOptions = {}): UpPlan {
  if (!config.agent?.entrypoint) {
    throw new Error(
      'airlock up runs a config-bound agent, but no [agent] block was found in ' +
        '.airlock/config.toml. Run `airlock init --detect` to wire one, or use ' +
        '`airlock serve` to wrap a bare model endpoint.',
    );
  }
  const port = opts.port ?? 3000;
  const env: Record<string, string> = { PORT: String(port) };

  if (opts.noPayment || !config.payment) {
    env.PAYMENT_ENABLED = '0';
  } else {
    const p = PaymentConfigSchema.parse(config.payment);
    env.PAYMENT_ENABLED = p.enabled ? '1' : '0';
    env.PUBLISHER_WALLET = p.wallet;
    env.PAYMENT_NETWORK = p.network;
    if (p.mode === 'flat') env.PRICE_USDC = p.priceUsdc;
  }

  // Concurrency knobs — only set when given, so the runtime keeps its own
  // defaults otherwise. A bare `AIRLOCK_MAX_CONCURRENCY=N airlock up` also works
  // because the spawned process inherits process.env.
  if (opts.maxConcurrency !== undefined) env.AIRLOCK_MAX_CONCURRENCY = String(opts.maxConcurrency);
  if (opts.maxQueue !== undefined) env.AIRLOCK_MAX_QUEUE = String(opts.maxQueue);
  if (opts.queueTimeout !== undefined) env.AIRLOCK_QUEUE_TIMEOUT_S = String(opts.queueTimeout);
  if (opts.buildPerCall !== undefined) env.AIRLOCK_BUILD_PER_CALL = opts.buildPerCall ? '1' : '0';

  return {
    python: opts.python ?? process.env.AIRLOCK_PYTHON ?? 'python3',
    args: ['-m', 'airlock_agent'],
    port,
    env,
  };
}

export interface UpHandle {
  /** The public URL, if a tunnel was opened. */
  url?: string;
  /** Stop the tunnel and the agent process. */
  stop: () => Promise<void>;
  /** Resolves when the agent process exits. */
  done: Promise<number>;
}

/** Poll the agent's /healthz until it responds or we give up. */
async function waitForHealth(
  port: number,
  fetchFn: typeof fetch,
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`agent exited (code ${child.exitCode}) before becoming healthy`);
    }
    try {
      const res = await fetchFn(`http://localhost:${port}/healthz`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`agent did not become healthy on :${port} within ${Math.round(timeoutMs / 1000)}s`);
}

/**
 * Launch the agent + tunnel and return a handle. The caller wires signal
 * handling (see the `up` command in cli.ts). The model is whatever the agent's
 * own code points at — local weights or a remote OPENAI_API_BASE in the env,
 * which the spawned process inherits.
 */
export async function runUp(opts: UpOptions = {}): Promise<UpHandle> {
  const cwd = opts.cwd ?? process.cwd();
  const config = await readConfig(cwd);
  const plan = resolveUpPlan(config, opts);
  const spawnFn = opts.spawnImpl ?? spawn;
  const startTunnelFn = opts.startTunnelImpl ?? startTunnel;
  const fetchFn = opts.fetchImpl ?? fetch;

  console.log(`airlock up  →  starting agent: ${plan.python} -m airlock_agent (:${plan.port})`);
  console.log(`  payment:  ${plan.env.PAYMENT_ENABLED === '1' ? `ON (wallet=${plan.env.PUBLISHER_WALLET})` : 'OFF'}`);

  const child = spawnFn(plan.python, plan.args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...plan.env },
  });

  const done = new Promise<number>((resolve) => {
    child.on('exit', (code) => resolve(code ?? 0));
  });

  let tunnel: TunnelHandle | undefined;
  try {
    await waitForHealth(plan.port, fetchFn, child, 120_000);
  } catch (err) {
    child.kill();
    throw err;
  }

  if (!opts.noTunnel) {
    console.log('  opening public tunnel…');
    tunnel = await startTunnelFn(plan.port);
    console.log(`\n✓ live at  ${tunnel.url}`);
    console.log(`  callers POST to:  ${tunnel.url}/v1/chat/completions`);
  } else {
    console.log(`\n✓ agent live on 0.0.0.0:${plan.port} (no tunnel)`);
    console.log(`  local:        http://localhost:${plan.port}/v1/chat/completions`);
    console.log(`  public host:  http://<this-server-ip>:${plan.port}/v1/chat/completions  (open the port / front with your own proxy)`);
  }
  console.log('  press Ctrl-C to stop');

  return {
    url: tunnel?.url,
    stop: async () => {
      tunnel?.stop();
      child.kill();
      await done;
    },
    done,
  };
}
