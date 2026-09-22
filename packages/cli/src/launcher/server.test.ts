import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLauncher } from './server.js';

describe('local launcher boundary', () => {
  let root: string;
  let launcher: Awaited<ReturnType<typeof startLauncher>>;
  let origin: string;
  let headers: Record<string, string>;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'airlock-launcher-test-'));
    launcher = await startLauncher({ root });
    const url = new URL(launcher.url);
    origin = url.origin;
    headers = { 'X-Airlock-Session': new URLSearchParams(url.hash.slice(1)).get('session')! };
  });
  afterAll(async () => { await launcher.close(); await rm(root, { recursive: true, force: true }); });

  it('serves the app without embedding its management capability', async () => {
    const res = await fetch(origin);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(await res.text()).not.toContain(headers['X-Airlock-Session']);
  });
  it('requires a valid session for discovery and every mutation', async () => {
    for (const path of ['state', 'console', 'start', 'stop', 'connection']) {
      expect((await fetch(`${origin}/api/${path}`)).status).toBe(401);
    }
    for (const token of ['a'.repeat(64), 'é'.repeat(64), '']) {
      expect((await fetch(`${origin}/api/state`, { headers: { 'X-Airlock-Session': token } })).status).toBe(401);
    }
    expect((await fetch(`${origin}/api/state`, { headers })).status).toBe(200);
  });
  it('rejects cross-origin calls and rebound hosts even with a valid session', async () => {
    expect((await fetch(`${origin}/api/state`, { headers: { ...headers, Origin: 'https://evil.example' } })).status).toBe(403);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      get(`${origin}/api/state`, { headers: { ...headers, Host: 'evil.example' } }, res => {
        res.resume(); resolve(res.statusCode);
      }).on('error', reject);
    });
    expect(status).toBe(403);
  });
  it('returns useful startup errors without starting arbitrary paths', async () => {
    const res = await fetch(`${origin}/api/start`, {
      method: 'POST', headers, body: JSON.stringify({ id: '../outside', local: true }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Choose an agent from this workspace.' });
    expect(await (await fetch(`${origin}/api/state`, { headers })).json()).toEqual({
      status: 'idle', message: '', active: null, agents: [],
    });
  });
});
