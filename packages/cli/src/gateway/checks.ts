import { Resolver } from 'node:dns/promises';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { createSocket } from 'node:dgram';
import { desktopHostname } from './config.js';

export interface GatewayCheck { name: string; status: 'ok' | 'action' | 'info'; detail: string }

/** UDP connect selects the OS route without sending a packet or contacting a service. */
async function routedAddress(): Promise<string | undefined> {
  return new Promise(resolve => {
    const socket = createSocket('udp4');
    const finish = (address?: string) => { clearTimeout(timer); socket.close(); resolve(address); };
    const timer = setTimeout(() => finish(), 1000);
    socket.once('error', () => finish());
    socket.connect(443, '8.8.8.8', () => finish(socket.address().address));
  });
}

async function portAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer(socket => socket.destroy());
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

export async function checkDesktopGateway(hostname?: string): Promise<GatewayCheck[]> {
  const checks: GatewayCheck[] = [];
  if (hostname) {
    hostname = desktopHostname(hostname);
    const resolver = new Resolver({ timeout: 2000, tries: 1 });
    const answers = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    const addresses = answers.flatMap(answer => answer.status === 'fulfilled' ? answer.value : []);
    checks.push({ name: 'Public address', status: addresses.length ? 'ok' : 'action', detail: addresses.length
      ? `${hostname} resolves to ${addresses.join(', ')}. These must be your home internet addresses.`
      : `Add a DNS record for ${hostname} pointing to your home public IP, then check again.` });
  } else {
    checks.push({ name: 'Public address', status: 'action', detail: 'Choose a domain or subdomain you control. You can save it below.' });
  }
  const available = await Promise.all([portAvailable(80), portAvailable(443)]);
  checks.push({ name: 'Desktop ports', status: available.every(Boolean) ? 'ok' : 'action', detail: available.every(Boolean)
    ? 'Ports 80 and 443 are available on this desktop.'
    : `Port ${[80, 443].filter((_, i) => !available[i]).join(' and ')} is unavailable. Another app may be using it, or your system may require permission.` });
  const preferred = await routedAddress();
  const local = preferred ? [preferred] : Object.values(networkInterfaces()).flatMap(entries => entries ?? [])
    .filter(entry => entry.family === 'IPv4' && !entry.internal).map(entry => entry.address);
  checks.push({ name: 'Router connection', status: 'info', detail:
    `Forward TCP ports 80 and 443 to this desktop${local.length ? ` (${local.join(' or ')})` : ''} in your router. Allow Caddy through your firewall. Start will check the HTTPS connection; these local checks do not prove internet reachability.` });
  return checks;
}
