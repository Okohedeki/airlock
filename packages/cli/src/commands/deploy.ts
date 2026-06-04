/**
 * `airlock deploy` — the real multi-container fleet (epic 09 + 08 + 12).
 *
 * Builds the worker image, launches N detached containers, registers each in the
 * fleet Registry, and fronts them with the router HTTP service (pipeline + reverse
 * proxy). `--canary <image>@<pct>` adds a canary version; `airlock expose` points a
 * tunnel at the router. The registry is in-memory in this process (v1); a durable
 * `_system/workers` registry is a later step.
 */

import { spawnSync } from 'node:child_process';
import { type Server } from 'node:http';

import { buildDockerRun } from '../exec.js';
import { type TunnelHandle, startTunnel } from '../tunnel.js';
import { Registry } from '../router/index.js';
import { startRouterServer } from '../router/server.js';
import { resolveBuildPlan, runBuild, slug } from './build.js';

export interface DeployOptions {
  cwd?: string;
  replicas?: number;
  /** Router (public) port. Replicas listen on port+1 … port+N internally. */
  port?: number;
  /** `<image>@<pct>` — add canary replicas of another image at pct% of new sessions. */
  canary?: string;
  /** Open a public tunnel at the router port. */
  expose?: boolean;
  /** Skip building (use the already-built image). */
  noBuild?: boolean;
  fetchImpl?: typeof fetch;
}

export interface DeployHandle {
  url?: string;
  routerPort: number;
  registry: Registry;
  stop: () => Promise<void>;
}

async function waitForPort(port: number, fetchFn: typeof fetch, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetchFn(`http://127.0.0.1:${port}/healthz`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`worker on :${port} did not become healthy`);
}

function runContainer(image: string, name: string, port: number, stateDir: string): void {
  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  const { args } = buildDockerRun({
    image, port, name, stateDir, detach: true, addHostGateway: true,
  });
  const r = spawnSync('docker', args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`failed to start container ${name}`);
}

export async function runDeploy(opts: DeployOptions = {}): Promise<DeployHandle> {
  const cwd = opts.cwd ?? process.cwd();
  const fetchFn = opts.fetchImpl ?? fetch;
  const replicas = Math.max(1, opts.replicas ?? 2);
  const routerPort = opts.port ?? 8080;
  const plan = resolveBuildPlan({ cwd });
  const workerName = slug(plan.image.split('/')[1]?.split(':')[0] ?? 'worker');
  const stateDir = `${cwd}/.airlock`;

  if (!opts.noBuild) await runBuild({ cwd });

  const reg = new Registry();
  const names: string[] = [];

  // Stable replicas.
  for (let i = 0; i < replicas; i++) {
    const name = `airlock-${workerName}-${i}`;
    const port = routerPort + 1 + i;
    runContainer(plan.image, name, port, stateDir);
    await waitForPort(port, fetchFn);
    names.push(name);
    reg.register({
      id: name, name: workerName, version: plan.tag, variant: 'default',
      host: '127.0.0.1', port, capabilities: [], costEstimate: 1, latencyMs: 50,
    });
  }
  reg.setRollout(workerName, { stable: plan.tag });

  // Optional canary version (epic 08): `<image>@<pct>`.
  if (opts.canary) {
    const [cimg, pctRaw] = opts.canary.split('@');
    if (!cimg) throw new Error('--canary expects <image>@<pct>');
    const pct = Number(pctRaw ?? '10');
    const cver = cimg.split(':')[1] ?? 'canary';
    const name = `airlock-${workerName}-canary`;
    const port = routerPort + 1 + replicas;
    runContainer(cimg, name, port, stateDir);
    await waitForPort(port, fetchFn);
    names.push(name);
    reg.register({
      id: name, name: workerName, version: cver, variant: 'default',
      host: '127.0.0.1', port, capabilities: [], costEstimate: 1, latencyMs: 50,
    });
    reg.setRollout(workerName, { stable: plan.tag, canary: { version: cver, pct } });
    console.log(`  canary ${cver} at ${pct}% of new sessions`);
  }

  const server: Server = await startRouterServer(reg, { worker: workerName }, routerPort);
  console.log(`\n✓ fleet live: router on :${routerPort} → ${replicas} replica(s)`);
  console.log(`  callers POST to:  http://localhost:${routerPort}/v1/chat/completions`);
  console.log(`  control:          http://localhost:${routerPort}/_control/status`);

  let tunnel: TunnelHandle | undefined;
  if (opts.expose) {
    tunnel = await startTunnel(routerPort);
    console.log(`\n✓ exposed at  ${tunnel.url}`);
  }

  return {
    url: tunnel?.url,
    routerPort,
    registry: reg,
    stop: async () => {
      tunnel?.stop();
      await new Promise<void>((r) => server.close(() => r()));
      for (const n of names) spawnSync('docker', ['rm', '-f', n], { stdio: 'ignore' });
    },
  };
}
