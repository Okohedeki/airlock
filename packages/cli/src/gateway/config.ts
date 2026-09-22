import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { relaySchema } from '../relay-config.js';

export interface DesktopGateway { hostname: string }
export const gatewayHome = () => join(homedir(), '.airlock', 'gateway');

export function desktopHostname(value: string): string {
  const hostname = value.trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/$/, '');
  if (!relaySchema.shape.hostname.safeParse(hostname).success || /\.(local|localhost|internal|test|invalid)$/.test(hostname)) {
    throw new Error('Enter a public domain such as agents.yourdomain.com, without a path or port.');
  }
  return hostname;
}

export async function loadDesktopGateway(home = gatewayHome()): Promise<DesktopGateway | undefined> {
  try {
    const saved = JSON.parse(await readFile(join(home, 'desktop.json'), 'utf8'));
    return { hostname: desktopHostname(saved.hostname) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('The saved desktop address could not be read. Save your address again in Gateway setup.');
  }
}

export async function saveDesktopGateway(hostname: string, home = gatewayHome()): Promise<DesktopGateway> {
  const config = { hostname: desktopHostname(hostname) };
  await mkdir(home, { recursive: true, mode: 0o700 });
  const temporary = join(home, `${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(config), { mode: 0o600 });
  await rename(temporary, join(home, 'desktop.json'));
  return config;
}

/** The desktop exposes only worker routes; local launcher administration stays private. */
export function desktopCaddyfile(hostname: string, workerPort: number): string {
  hostname = desktopHostname(hostname);
  if (!Number.isInteger(workerPort) || workerPort < 1024 || workerPort > 65535) throw new Error('Invalid worker port.');
  return `{
  admin off
}
${hostname} {
  @worker path /healthz /console /console/* /v1/* /metrics
  handle @worker {
    reverse_proxy 127.0.0.1:${workerPort} {
      flush_interval -1
    }
  }
  handle {
    respond "Not found" 404
  }
}
`;
}
