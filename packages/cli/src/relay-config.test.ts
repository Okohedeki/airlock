import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { readRelayConfig, relaySchema, renderFrpcConfig } from './relay-config.js';

const profile = { hostname: 'agent.example.com', serverAddr: 'relay.example.com', caFile: 'ca.pem' };

describe('native relay configuration', () => {
  it.each(['https://example.com', 'example.com/path', 'x\nexample.com', '*.example.com'])('rejects unsafe hostname %s', (hostname) => {
    expect(() => relaySchema.parse({ ...profile, hostname })).toThrow();
  });

  it('requires explicit trust and rejects unknown settings or invalid ports', () => {
    expect(() => relaySchema.parse({ ...profile, caFile: '' })).toThrow();
    expect(() => relaySchema.parse({ ...profile, insecure: true })).toThrow();
    expect(() => relaySchema.parse({ ...profile, serverPort: 65536 })).toThrow();
    expect(() => renderFrpcConfig(relaySchema.parse(profile), 1.5)).toThrow();
  });

  it('pins relay identity, keeps worker on loopback, and omits credentials', () => {
    const raw = renderFrpcConfig(relaySchema.parse(profile), 3000);
    const config = JSON.parse(raw);
    expect(config.transport.tls).toEqual({
      enable: true, trustedCaFile: 'ca.pem', serverName: 'relay.example.com',
    });
    expect(config.auth.token).toBe('{{ .Envs.AIRLOCK_RELAY_TOKEN }}');
    expect(config.proxies[0]).toMatchObject({ type: 'tcp', localIP: '127.0.0.1', localPort: 3000, remotePort: 18080 });
    expect(config.loginFailExit).toBe(false);
  });

  it('resolves paths beside the profile and fails when trust material is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'airlock-relay-test-'));
    try {
      const path = join(dir, 'relay.json');
      await writeFile(path, JSON.stringify({ ...profile, frpc: './bin/frpc' }));
      await expect(readRelayConfig(path)).rejects.toThrow();
      await writeFile(join(dir, 'ca.pem'), 'test CA');
      expect(await readRelayConfig(path)).toMatchObject({ caFile: join(dir, 'ca.pem'), frpc: join(dir, 'bin/frpc') });
      await writeFile(path, JSON.stringify({ ...profile, serverPort: 18080 }));
      await expect(readRelayConfig(path)).rejects.toThrow(/must differ/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
