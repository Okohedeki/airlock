import { type Server, createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Registry } from './index.js';
import { startRouterServer } from './server.js';

/** A fake worker that just reports which replica served the request. */
function fakeWorker(id: string): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ served_by: id, echo: body }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port }));
  });
}

describe('fleet router service (hermetic — fake upstreams, no docker)', () => {
  let reg: Registry;
  let router: Server;
  let routerPort: number;
  const upstreams: Server[] = [];

  beforeAll(async () => {
    reg = new Registry();
    const a = await fakeWorker('v1-a');
    const b = await fakeWorker('v1-b');
    const c = await fakeWorker('v2-canary');
    upstreams.push(a.server, b.server, c.server);
    reg.register({ id: 'v1-a', name: 'w', version: 'v1', variant: 'default', host: '127.0.0.1', port: a.port, capabilities: [], costEstimate: 1, latencyMs: 10 });
    reg.register({ id: 'v1-b', name: 'w', version: 'v1', variant: 'default', host: '127.0.0.1', port: b.port, capabilities: [], costEstimate: 1, latencyMs: 10 });
    reg.register({ id: 'v2-canary', name: 'w', version: 'v2', variant: 'default', host: '127.0.0.1', port: c.port, capabilities: [], costEstimate: 1, latencyMs: 10 });
    reg.setRollout('w', { stable: 'v1' });
    router = await startRouterServer(reg, { worker: 'w' }, 0);
    routerPort = (router.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => router.close(() => r()));
    for (const s of upstreams) await new Promise<void>((r) => s.close(() => r()));
  });

  const post = (headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}',
    }).then((r) => r.json() as Promise<{ served_by: string }>);

  it('reverse-proxies to a worker and load-balances across replicas', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) seen.add((await post()).served_by);
    expect([...seen].every((s) => s.startsWith('v1'))).toBe(true);
    expect(seen.size).toBeGreaterThanOrEqual(2); // both v1 replicas hit
  });

  it('pins a session to one replica (sticky affinity)', async () => {
    const first = (await post({ 'x-airlock-session': 'sess-1' })).served_by;
    for (let i = 0; i < 4; i++) {
      expect((await post({ 'x-airlock-session': 'sess-1' })).served_by).toBe(first);
    }
  });

  it('routes new sessions to the canary, then rolls back', async () => {
    reg.setRollout('w', { stable: 'v1', canary: { version: 'v2', pct: 100 } });
    expect((await post({ 'x-airlock-session': 'canary-1' })).served_by).toBe('v2-canary');
    // control API rollback → stable wins for new sessions
    await fetch(`http://127.0.0.1:${routerPort}/_control/rollback`, { method: 'POST' });
    expect((await post({ 'x-airlock-session': 'after-rollback' })).served_by).toMatch(/^v1/);
  });

  it('promote via the control API shifts new sessions to the version', async () => {
    await fetch(`http://127.0.0.1:${routerPort}/_control/promote`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 'v2' }),
    });
    expect((await post({ 'x-airlock-session': 'after-promote' })).served_by).toBe('v2-canary');
    const status = await fetch(`http://127.0.0.1:${routerPort}/_control/status`).then((r) => r.json());
    expect(status.rollout.stable).toBe('v2');
  });
});
