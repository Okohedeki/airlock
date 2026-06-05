import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ingressConfig, pickZone, provisionTunnel, writeTokenToEnv } from './tunnel-provision.js';

describe('tunnel provision (mocked Cloudflare API)', () => {
  it('pickZone matches the longest zone suffix', () => {
    const zones = [{ id: 'z1', name: 'example.com' }, { id: 'z2', name: 'sub.example.com' }];
    expect(pickZone('agent.sub.example.com', zones).id).toBe('z2');
    expect(pickZone('agent.example.com', zones).id).toBe('z1');
    expect(() => pickZone('agent.other.com', zones)).toThrow(/no Cloudflare zone/);
  });

  it('ingressConfig routes the hostname to the local port with a 404 fallback', () => {
    const cfg = ingressConfig('a.example.com', 3000) as any;
    expect(cfg.config.ingress[0]).toEqual({ hostname: 'a.example.com', service: 'http://localhost:3000' });
    expect(cfg.config.ingress[1]).toEqual({ service: 'http_status:404' });
  });

  it('provisionTunnel creates the tunnel, sets ingress, upserts DNS, returns the token', async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string, init: any) => {
      const path = url.replace('https://api.cloudflare.com/client/v4', '');
      calls.push(`${init.method} ${path.split('?')[0]}`);
      const ok = (result: unknown) => ({ ok: true, json: async () => ({ success: true, result }) });
      if (path === '/accounts' && init.method === 'GET') return ok([{ id: 'acct1', name: 'me' }]);
      if (path.startsWith('/zones?') && init.method === 'GET') return ok([{ id: 'zone1', name: 'example.com' }]);
      if (path.includes('/cfd_tunnel?name=')) return ok([]); // none existing
      if (path.endsWith('/cfd_tunnel') && init.method === 'POST') return ok({ id: 'tun1', token: 'CONNECTOR_TOKEN' });
      if (path.includes('/configurations') && init.method === 'PUT') return ok({});
      if (path.includes('/dns_records?name=')) return ok([]); // no existing record
      if (path.endsWith('/dns_records') && init.method === 'POST') return ok({ id: 'rec1' });
      throw new Error(`unexpected call ${init.method} ${path}`);
    }) as unknown as typeof fetch;

    const r = await provisionTunnel({
      apiToken: 'API_TOKEN', hostname: 'agent.example.com', port: 3000, fetchImpl: fakeFetch,
    });
    expect(r.token).toBe('CONNECTOR_TOKEN');
    expect(r.tunnelId).toBe('tun1');
    expect(r.cname).toBe('tun1.cfargotunnel.com');
    // verify the API dance happened in order
    expect(calls).toContain('POST /accounts/acct1/cfd_tunnel');
    expect(calls).toContain('PUT /accounts/acct1/cfd_tunnel/tun1/configurations');
    expect(calls).toContain('POST /zones/zone1/dns_records');
  });

  it('writeTokenToEnv creates and then replaces the token line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'airlock-env-'));
    writeTokenToEnv(dir, 'TOK1');
    expect(readFileSync(join(dir, '.env'), 'utf8')).toContain('AIRLOCK_CF_TUNNEL_TOKEN=TOK1');
    writeFileSync(join(dir, '.env'), 'FOO=bar\nAIRLOCK_CF_TUNNEL_TOKEN=OLD\nBAZ=1\n');
    writeTokenToEnv(dir, 'TOK2');
    const out = readFileSync(join(dir, '.env'), 'utf8');
    expect(out).toContain('AIRLOCK_CF_TUNNEL_TOKEN=TOK2');
    expect(out).not.toContain('OLD');
    expect(out).toContain('FOO=bar');
  });
});
