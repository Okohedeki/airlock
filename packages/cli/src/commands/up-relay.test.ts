import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess, spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runUp } from './up.js';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const cwd = mkdtempSync(join(tmpdir(), 'airlock-up-relay-'));
  dirs.push(cwd);
  mkdirSync(join(cwd, '.airlock'));
  writeFileSync(join(cwd, 'worker.yaml'), 'harness: stub\n');
  writeFileSync(join(cwd, '.airlock', 'ca.pem'), 'test');
  writeFileSync(join(cwd, '.airlock', 'relay.json'), JSON.stringify({
    hostname: 'agent.example.com', serverAddr: 'relay.example.com', caFile: 'ca.pem',
  }));
  vi.stubEnv('AIRLOCK_OPERATOR_TOKEN', 'operator-secret');
  vi.stubEnv('AIRLOCK_RELAY_TOKEN', 'a'.repeat(64));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperty(child, 'exitCode', { value: null });
  child.kill = vi.fn(() => { child.emit('exit', 0); return true; });
  const spawnImpl = vi.fn(() => child) as unknown as typeof spawn;
  const fetchImpl = vi.fn(async (url: string | URL | Request) => new Response('{}', {
    status: String(url).endsWith('/healthz') ? 200 : 401,
  }));
  let finish!: (code: number) => void;
  const done = new Promise<number>((resolve) => { finish = resolve; });
  const stop = vi.fn(() => finish(0));
  const startRelayImpl = vi.fn(async () => ({ url: 'https://agent.example.com', done, stop }));
  return { cwd, child, spawnImpl, fetchImpl, startRelayImpl, finish, stop };
}

describe('public-first startup', () => {
  it('publishes by default and passes the same launch identity to worker and connector', async () => {
    const s = setup();
    const handle = await runUp(s);
    expect(handle.url).toBe('https://agent.example.com');
    const workerEnv = vi.mocked(s.spawnImpl).mock.calls[0]![2]!.env!;
    const relayOptions = s.startRelayImpl.mock.calls[0] as unknown as [number, { instance: string }];
    expect(workerEnv.AIRLOCK_PUBLIC_INSTANCE).toBe(relayOptions[1].instance);
    expect(workerEnv.AIRLOCK_HOST).toBe('127.0.0.1');
    await handle.stop();
    expect(s.stop).toHaveBeenCalled();
    expect(s.child.kill).toHaveBeenCalled();
  });

  it('keeps local development explicit', async () => {
    const s = setup();
    const handle = await runUp({ ...s, noTunnel: true });
    expect(handle.url).toBeUndefined();
    expect(s.startRelayImpl).not.toHaveBeenCalled();
    await handle.stop();
  });

  it('fails before spawning without a relay profile', async () => {
    const s = setup();
    await expect(runUp({ ...s, relay: 'missing.json' })).rejects.toThrow();
    expect(s.spawnImpl).not.toHaveBeenCalled();
  });

  it('refuses to publish a worker accepting anonymous jobs', async () => {
    const s = setup();
    s.fetchImpl.mockImplementation(async () => new Response('{}'));
    await expect(runUp(s)).rejects.toThrow(/unauthenticated/);
    expect(s.startRelayImpl).not.toHaveBeenCalled();
    expect(s.child.kill).toHaveBeenCalled();
  });

  it('stops the worker when publication fails or the connector exits', async () => {
    const s = setup();
    s.startRelayImpl.mockRejectedValueOnce(new Error('relay unavailable'));
    await expect(runUp(s)).rejects.toThrow(/relay unavailable/);
    expect(s.child.kill).toHaveBeenCalled();
    const second = setup();
    const handle = await runUp(second);
    second.finish(9);
    expect(await handle.done).toBe(1);
    expect(second.child.kill).toHaveBeenCalled();
  });
});
