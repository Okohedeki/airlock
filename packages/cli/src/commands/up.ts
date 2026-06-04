/**
 * `airlock up` — run a self-hosted agent on the publisher's OWN hardware and
 * front it with a public URL. This is the self-host production path: the agent
 * loop (`python -m airlock_agent`) runs here, and airlock only operates the
 * tunnel that exposes it — never the compute, never the model (which may be
 * local or a remote OPENAI_API_BASE).
 *
 * By default the public URL is an ephemeral *.trycloudflare.com quick tunnel
 * (no account needed). Pass `--durable` to instead run a stable named tunnel on
 * the publisher's OWN Cloudflare account (bring-your-own connector token +
 * hostname; see startNamedTunnel and docs/durable-hosting.md). airlock holds no
 * Cloudflare keys either way.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { ZodError } from 'zod';
import {
  type AirlockConfig,
  CF_TUNNEL_TOKEN_ENV,
  readConfig,
  validateTunnel,
} from '../config-file.js';
import {
  startNamedTunnel,
  startTunnel,
  type TunnelHandle,
  type TunnelTuning,
} from '../tunnel.js';

export interface UpOptions {
  cwd?: string;
  /** Port the agent listens on (and we tunnel to). */
  port?: number;
  /** Python executable to run `-m airlock_agent` with (respects an active venv). */
  python?: string;
  /** Run the agent locally but don't open a public tunnel. */
  noTunnel?: boolean;
  /** Use a durable named tunnel on the publisher's own Cloudflare account (vs. ephemeral quick tunnel). */
  durable?: boolean;
  /** Max agent runs in flight at once before callers queue (AIRLOCK_MAX_CONCURRENCY). */
  maxConcurrency?: number;
  /** Max callers waiting beyond the running set before new ones get 429 (AIRLOCK_MAX_QUEUE). */
  maxQueue?: number;
  /** Seconds a caller waits in the queue before a 429 (AIRLOCK_QUEUE_TIMEOUT_S). */
  queueTimeout?: number;
  /** Force per-call agent rebuild on/off (AIRLOCK_BUILD_PER_CALL); default inferred at runtime. */
  buildPerCall?: boolean;
  /** cloudflared edge protocol (quic/http2/auto); overrides [tunnel].protocol. */
  cfProtocol?: TunnelTuning['protocol'];
  /** Pin the connector to a Cloudflare region; overrides [tunnel].region. */
  cfRegion?: string;
  /** Expose cloudflared metrics on host:port; overrides [tunnel].metrics. */
  cfMetrics?: string;
  /** Injectables for tests. */
  spawnImpl?: typeof spawn;
  startTunnelImpl?: typeof startTunnel;
  startNamedTunnelImpl?: typeof startNamedTunnel;
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
 * Translate config + options into a concrete launch plan. Pure + testable.
 * Throws if there's no `[agent]` block — `up` runs a config-bound harness.
 */
export function resolveUpPlan(config: AirlockConfig, opts: UpOptions = {}): UpPlan {
  if (!config.agent?.entrypoint) {
    throw new Error(
      'airlock up runs a config-bound agent, but no [agent] block was found in ' +
        '.airlock/config.toml. Run `airlock init --detect` to wire one.',
    );
  }
  const port = opts.port ?? 3000;
  const env: Record<string, string> = { PORT: String(port) };

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

/**
 * Resolve durable-tunnel settings from `--durable` / `[tunnel].durable`. Returns
 * the publisher's bring-your-own Cloudflare token + hostname, or null when durable
 * mode isn't requested (the ephemeral quick tunnel is used instead). Throws an
 * actionable error when durable is requested but the BYO credentials are missing.
 */
export function resolveDurableTunnel(
  config: AirlockConfig,
  opts: UpOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): { token: string; hostname: string } | null {
  let tcfg: ReturnType<typeof validateTunnel>;
  try {
    tcfg = validateTunnel(config);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new Error(
        `invalid [tunnel] config: ${err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    }
    throw err;
  }

  const durable = opts.durable ?? tcfg?.durable ?? false;
  if (!durable) return null;

  const token = env[CF_TUNNEL_TOKEN_ENV];
  const hostname = tcfg?.hostname;
  const missing: string[] = [];
  if (!token)
    missing.push(`export ${CF_TUNNEL_TOKEN_ENV}=<your Cloudflare Tunnel connector token>`);
  if (!hostname)
    missing.push('set [tunnel].hostname in .airlock/config.toml to the hostname you routed');
  if (!token || !hostname) {
    throw new Error(
      'durable tunnel requested but your bring-your-own Cloudflare setup is incomplete:\n' +
        missing.map((m) => `  • ${m}`).join('\n') +
        '\nCreate the tunnel + Public Hostname in YOUR Cloudflare Zero Trust dashboard first — ' +
        'see docs/durable-hosting.md. airlock holds no Cloudflare keys.',
    );
  }
  return { token, hostname };
}

/**
 * Merge connector tuning from the `[tunnel]` config block with CLI/option
 * overrides (options win). Returns undefined when nothing is set, so cloudflared
 * keeps its own defaults.
 */
export function resolveTunnelTuning(
  config: AirlockConfig,
  opts: UpOptions = {},
): TunnelTuning | undefined {
  const tcfg = validateTunnel(config);
  const tuning: TunnelTuning = {};
  const protocol = opts.cfProtocol ?? tcfg?.protocol;
  const region = opts.cfRegion ?? tcfg?.region;
  const metrics = opts.cfMetrics ?? tcfg?.metrics;
  if (protocol) tuning.protocol = protocol;
  if (region) tuning.region = region;
  if (metrics) tuning.metrics = metrics;
  return Object.keys(tuning).length > 0 ? tuning : undefined;
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
  throw new Error(
    `agent did not become healthy on :${port} within ${Math.round(timeoutMs / 1000)}s`,
  );
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
  const startNamedTunnelFn = opts.startNamedTunnelImpl ?? startNamedTunnel;
  const fetchFn = opts.fetchImpl ?? fetch;

  // Validate durable-tunnel BYO credentials up front (before spawning the agent),
  // so a misconfigured `--durable` fails fast with actionable guidance.
  const durable = opts.noTunnel ? null : resolveDurableTunnel(config, opts);

  console.log(`airlock up  →  starting agent: ${plan.python} -m airlock_agent (:${plan.port})`);

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
    const tuning = resolveTunnelTuning(config, opts);
    if (durable) {
      console.log('  opening durable named tunnel on your Cloudflare account…');
      tunnel = await startNamedTunnelFn(plan.port, { ...durable, tuning });
      console.log(`\n✓ live (durable) at  ${tunnel.url}`);
    } else {
      console.log('  opening public tunnel…');
      tunnel = await startTunnelFn(plan.port, { tuning });
      console.log(`\n✓ live at  ${tunnel.url}`);
    }
    console.log(`  callers POST to:  ${tunnel.url}/v1/chat/completions`);
  } else {
    console.log(`\n✓ agent live on 0.0.0.0:${plan.port} (no tunnel)`);
    console.log(`  local:        http://localhost:${plan.port}/v1/chat/completions`);
    console.log(
      `  public host:  http://<this-server-ip>:${plan.port}/v1/chat/completions  (open the port / front with your own proxy)`,
    );
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
