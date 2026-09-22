import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

const hostname = z.string().max(253).regex(
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
  'expected a lowercase DNS hostname, without a scheme, port, or path',
);
const port = z.number().int().min(1024).max(65535);
export const relaySchema = z.object({
  hostname,
  serverAddr: hostname,
  serverPort: port.default(7000),
  remotePort: port.default(18080),
  caFile: z.string().min(1),
  frpc: z.string().min(1).default('frpc'),
}).strict();
export type RelayConfig = z.infer<typeof relaySchema>;

/** Profiles contain routing and CA paths only; credentials remain in the environment. */
export async function readRelayConfig(path: string): Promise<RelayConfig> {
  const config = relaySchema.parse(JSON.parse(await readFile(path, 'utf8')));
  config.caFile = resolve(dirname(path), config.caFile);
  await readFile(config.caFile); // Fail before starting a worker if trust material is missing.
  if (config.frpc.includes('/') || config.frpc.includes('\\')) {
    config.frpc = resolve(dirname(path), config.frpc);
  }
  if (config.serverPort === config.remotePort) {
    throw new Error('relay serverPort and remotePort must differ');
  }
  return config;
}

/** frp expands this environment reference itself; never write the token to disk. */
export function renderFrpcConfig(config: RelayConfig, localPort: number): string {
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
    throw new Error('invalid worker port');
  }
  return JSON.stringify({
    serverAddr: config.serverAddr,
    serverPort: config.serverPort,
    loginFailExit: false,
    auth: {
      method: 'token',
      token: '{{ .Envs.AIRLOCK_RELAY_TOKEN }}',
      additionalScopes: ['HeartBeats', 'NewWorkConns'],
    },
    transport: { tls: {
      enable: true,
      trustedCaFile: config.caFile,
      serverName: config.serverAddr,
    } },
    proxies: [{
      name: 'airlock', type: 'tcp', localIP: '127.0.0.1',
      localPort, remotePort: config.remotePort,
    }],
  }, null, 2);
}
