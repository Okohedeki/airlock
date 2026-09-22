import { relaySchema, type RelayConfig } from './relay-config.js';

/** One trusted worker per relay configuration. No public frps proxy port or dashboard. */
export function renderRelayServer(input: RelayConfig): { caddyfile: string; frps: string } {
  const config = relaySchema.parse(input);
  if (config.serverPort === config.remotePort) throw new Error('relay ports must differ');
  return {
    caddyfile: `{
  admin off
}

${config.hostname} {
  @worker path /healthz /console /console/* /v1/* /metrics
  handle @worker {
    reverse_proxy 127.0.0.1:${config.remotePort} {
      flush_interval -1
    }
  }
  handle {
    respond "Not found" 404
  }
}
`,
    frps: JSON.stringify({
      bindAddr: '0.0.0.0', bindPort: config.serverPort,
      proxyBindAddr: '127.0.0.1',
      allowPorts: [{ single: config.remotePort }],
      maxPortsPerClient: 1,
      detailedErrorsToClient: false,
      auth: {
        method: 'token', token: '{{ .Envs.AIRLOCK_RELAY_TOKEN }}',
        additionalScopes: ['HeartBeats', 'NewWorkConns'],
      },
      transport: { tls: { force: true, certFile: 'relay.crt', keyFile: 'relay.key' } },
    }, null, 2) + '\n',
  };
}
