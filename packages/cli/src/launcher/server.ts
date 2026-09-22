import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { discoverAgents } from './catalog.js';
import { agentSession } from './session.js';
import { page } from './page.js';
import { styles } from './design.js';
import { client } from './client.js';
import { loadDesktopGateway, saveDesktopGateway } from '../gateway/config.js';
import { caddyInstalled, installCaddy } from '../gateway/caddy.js';
import { checkDesktopGateway } from '../gateway/checks.js';

/** Local-only launcher. Possession of the CLI bootstrap link authorizes this browser session. */
export async function startLauncher(opts: {
  root: string; port?: number; workerPort?: number; python?: string; relay?: string;
}) {
  const agents = await discoverAgents(resolve(opts.root));
  let gatewayError = '';
  let desktop = await loadDesktopGateway().catch(error => { gatewayError = error.message; return undefined; });
  let preparingGateway = false;
  const session = agentSession(agents, {
    python: opts.python, port: opts.workerPort, relay: opts.relay,
    desktop: opts.relay ? undefined : desktop, desktopMode: !opts.relay,
  });
  const capability = randomBytes(32).toString('hex');
  let origin = '';
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (code: number, data: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data));
    };
    if (`http://${req.headers.host}` !== origin || (req.headers.origin && req.headers.origin !== origin)) {
      json(403, { error: 'Open Airlock from the link printed in your terminal.' }); return;
    }
    const path = new URL(req.url ?? '/', origin).pathname;
    if (!path.startsWith('/api/')) {
      if (req.method !== 'GET') { json(405, { error: 'Method not allowed' }); return; }
      const assets: Record<string, [string, string]> = {
        '/': ['text/html', page], '/style.css': ['text/css', styles], '/app.js': ['text/javascript', client],
      };
      if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      const asset = assets[path];
      if (!asset) { json(404, { error: 'Not found' }); return; }
      res.writeHead(200, { 'Content-Type': `${asset[0]}; charset=utf-8` }); res.end(asset[1]); return;
    }
    const supplied = req.headers['x-airlock-session'];
    if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(capability))) {
      json(401, { error: 'Open Airlock using the link from airlock up to reconnect this browser.' }); return;
    }
    try {
      if (req.method === 'GET' && path === '/api/state') { json(200, session.state()); return; }
      if (req.method === 'GET' && path === '/api/gateway') {
        json(200, { hostname: desktop?.hostname ?? '', installed: await caddyInstalled(), preparing: preparingGateway, error: gatewayError }); return;
      }
      if (req.method === 'GET' && path === '/api/console') { json(200, { url: session.consoleLink() }); return; }
      if (req.method !== 'POST') { json(405, { error: 'Method not allowed' }); return; }
      let raw = '';
      for await (const chunk of req) {
        raw += chunk.toString();
        if (raw.length > 16384) { json(413, { error: 'Request is too large' }); return; }
      }
      const body = JSON.parse(raw || '{}');
      if (path.startsWith('/api/gateway/')) {
        if (preparingGateway || ['starting', 'running'].includes(session.state().status)) throw new Error('Finish setup or stop your agent before changing the gateway.');
        preparingGateway = true;
        try {
          if (path === '/api/gateway/install') await installCaddy();
          else if (path === '/api/gateway/save') {
            if (typeof body.hostname !== 'string') throw new Error('Enter the public address you want to use.');
            desktop = await saveDesktopGateway(body.hostname);
            session.configureDesktop(desktop.hostname);
            gatewayError = '';
          } else if (path === '/api/gateway/check') {
            json(200, { checks: await checkDesktopGateway(desktop?.hostname) }); return;
          } else { json(404, { error: 'Not found' }); return; }
        } finally { preparingGateway = false; }
        json(200, { ok: true }); return;
      }
      if (path === '/api/start') {
        if (preparingGateway) throw new Error('Wait for gateway setup to finish, then press Start.');
        if (typeof body.id !== 'string' || typeof body.local !== 'boolean') throw new Error('Choose an agent and launch mode.');
        await session.start(body.id, body.local);
      } else if (path === '/api/stop') await session.stop();
      else if (path === '/api/connection') {
        if (typeof body.path !== 'string') throw new Error('Choose a connection profile.');
        session.configure(body.path);
      } else { json(404, { error: 'Not found' }); return; }
      json(200, session.state());
    } catch (error) { json(400, { error: (error as Error).message }); }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
  return {
    url: `${origin}/#session=${capability}`,
    close: async () => {
      await session.stop();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
