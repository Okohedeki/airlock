import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderFrpcConfig, type RelayConfig } from './relay-config.js';

export interface RelayHandle {
  url: string;
  stop: () => void;
  done: Promise<number>;
}

/** frpc reconnects across network interruptions; a process failure ends publication. */
export async function startRelay(port: number, opts: {
  config: RelayConfig;
  instance: string;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: typeof spawn;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<RelayHandle> {
  const env = opts.env ?? process.env;
  if (!/^[a-f0-9]{64}$/i.test(env.AIRLOCK_RELAY_TOKEN ?? '')) {
    throw new Error('AIRLOCK_RELAY_TOKEN must be a 64-character hex secret shared with your relay');
  }
  if (!opts.instance) throw new Error('relay startup requires a worker launch identity');
  const dir = await mkdtemp(join(tmpdir(), 'airlock-frpc-'));
  let child: ChildProcess | undefined;
  let closed = false;
  let failure: Error | undefined;
  try {
    const path = join(dir, 'frpc.json');
    await writeFile(path, renderFrpcConfig(opts.config, port), { mode: 0o600 });
    child = (opts.spawnImpl ?? spawn)(opts.config.frpc, ['-c', path], {
      stdio: 'ignore', windowsHide: true,
      // Do not give the connector model keys or operator credentials.
      env: {
        PATH: env.PATH ?? env.Path, SystemRoot: env.SystemRoot,
        HOME: env.HOME, TMPDIR: env.TMPDIR, TEMP: env.TEMP, TMP: env.TMP,
        AIRLOCK_RELAY_TOKEN: env.AIRLOCK_RELAY_TOKEN,
      },
    });
    const done = new Promise<number>((resolve) => {
      child!.once('error', () => {
        failure = new Error('could not start frpc; install the native binary or set frpc in relay.json');
      });
      child!.once('close', (code) => {
        closed = true;
        failure ??= new Error(`frpc exited (code ${code ?? 'signal'})`);
        void rm(dir, { recursive: true, force: true }).catch(() => {});
        resolve(code ?? 1);
      });
    });
    const url = `https://${opts.config.hostname}`;
    const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
    let ready = false;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      try {
        const response = await (opts.fetchImpl ?? fetch)(`${url}/healthz`, {
          redirect: 'error', headers: { 'Cache-Control': 'no-store' },
          signal: AbortSignal.timeout(Math.max(1, Math.min(3000, deadline - Date.now()))),
        });
        const health = response.ok ? await response.json() as { ok?: boolean; instance?: string } : null;
        if (health?.ok === true && health.instance === opts.instance) {
          ready = true;
          break;
        }
      } catch { /* Relay or certificate provisioning may still be connecting. */ }
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, Math.max(1, deadline - Date.now()))));
    }
    if (failure) throw failure;
    if (!ready) throw new Error('public relay did not reach this worker; check Caddy, DNS, certificates, and frps');
    return { url, done, stop: () => { if (!closed) child!.kill(); } };
  } catch (error) {
    child?.kill();
    // On Windows a running frpc may hold the file; its close handler retries cleanup.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
