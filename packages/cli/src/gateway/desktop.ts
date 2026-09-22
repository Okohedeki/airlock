import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { desktopCaddyfile, desktopHostname, gatewayHome, type DesktopGateway } from './config.js';
import { caddyInstalled, caddyPath } from './caddy.js';
import type { RelayHandle } from '../relay.js';

/** Caddy is the public edge on the same desktop as the loopback-only worker. */
export async function startDesktopGateway(port: number, opts: {
  config: DesktopGateway; instance: string; home?: string;
  spawnImpl?: typeof spawn; fetchImpl?: typeof fetch; timeoutMs?: number;
}): Promise<RelayHandle> {
  const hostname = desktopHostname(opts.config.hostname);
  const home = opts.home ?? gatewayHome();
  if (!opts.instance) throw new Error('Gateway startup requires an agent launch identity.');
  if (!await caddyInstalled(home)) throw new Error('Prepare this desktop in Gateway setup before starting.');
  const runs = join(home, 'runs');
  await mkdir(runs, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(runs, 'gateway-'));
  let child: ChildProcess | undefined;
  let done: Promise<number> | undefined;
  let failure: Error | undefined;
  let closed = false;
  const cleanup = async () => {
    if (!resolve(directory).startsWith(resolve(runs) + sep)) throw new Error('Invalid gateway cleanup path.');
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const config = join(directory, 'Caddyfile');
    await writeFile(config, desktopCaddyfile(hostname, port));
    child = (opts.spawnImpl ?? spawn)(caddyPath(home), ['run', '--config', config, '--adapter', 'caddyfile'], {
      stdio: 'ignore', windowsHide: true,
      env: {
        PATH: process.env.PATH ?? process.env.Path, SystemRoot: process.env.SystemRoot,
        HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
        APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA,
        XDG_DATA_HOME: join(home, 'data'), XDG_CONFIG_HOME: join(home, 'config'),
      },
    });
    done = new Promise<number>(resolve => {
      child!.once('error', () => {
        failure = new Error('The desktop gateway could not start. Check that Caddy is allowed to run.');
      });
      child!.once('close', code => {
        closed = true;
        failure ??= new Error('The desktop gateway stopped. Check whether another app uses ports 80 or 443, or your system requires permission to open them.');
        resolve(code ?? 1);
      });
    });
    const url = `https://${hostname}`;
    const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
    while (Date.now() < deadline) {
      if (failure) throw failure;
      try {
        const response = await (opts.fetchImpl ?? fetch)(`${url}/healthz`, {
          redirect: 'error', headers: { 'Cache-Control': 'no-store' },
          signal: AbortSignal.timeout(Math.max(1, Math.min(3000, deadline - Date.now()))),
        });
        const health = response.ok ? await response.json() as { ok?: boolean; instance?: string } : null;
        if (health?.ok === true && health.instance === opts.instance && !failure) {
          return { url, done: done.finally(cleanup), stop: () => { if (!closed) child!.kill(); } };
        }
      } catch { /* DNS propagation and first certificate issuance can take time. */ }
      await new Promise(resolve => setTimeout(resolve, Math.min(500, Math.max(1, deadline - Date.now()))));
    }
    if (failure) throw failure;
    throw new Error('Your HTTPS address could not reach this agent. Check that the domain points to your home public IP and your router forwards TCP 80 and 443 to this desktop. If your provider uses shared addressing (CGNAT), ask for a public IP. Some routers also require NAT loopback for this check.');
  } catch (error) {
    if (!closed) child?.kill();
    await done;
    await cleanup();
    throw error;
  }
}
