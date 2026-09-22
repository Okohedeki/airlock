import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startDesktopGateway } from './desktop.js';
import { caddyPath } from './caddy.js';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of directories.splice(0)) {
    if (!resolve(dir).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe cleanup');
    await rm(dir, { recursive: true, force: true });
  }
});

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'airlock-desktop-test-'));
  directories.push(home);
  await mkdir(dirname(caddyPath(home)), { recursive: true });
  await writeFile(caddyPath(home), 'fake binary; spawn is injected');
  const child = new EventEmitter() as ChildProcess;
  child.kill = vi.fn(() => { child.emit('close', 0); return true; });
  const spawnImpl = vi.fn(() => child) as unknown as typeof spawn;
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, instance: 'this-agent' })));
  return { home, child, spawnImpl, fetchImpl, config: { hostname: 'agents.example.com' }, instance: 'this-agent' };
}

describe('desktop gateway lifecycle', () => {
  it('generates restricted loopback routing without exposing model or management secrets', async () => {
    const s = await setup();
    vi.stubEnv('OPENAI_API_KEY', 'model-secret');
    vi.stubEnv('AIRLOCK_OPERATOR_TOKEN', 'operator-secret');
    const handle = await startDesktopGateway(3000, s);
    const [, args, options] = vi.mocked(s.spawnImpl).mock.calls[0]!;
    const config = await readFile(args![2], 'utf8');
    expect(config).toContain('reverse_proxy 127.0.0.1:3000');
    expect(config).toContain('admin off');
    expect(config).toContain('respond "Not found" 404');
    expect(options?.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(options?.env).not.toHaveProperty('AIRLOCK_OPERATOR_TOKEN');
    expect(handle.url).toBe('https://agents.example.com');
    handle.stop();
    await handle.done;
    expect(await readdir(join(s.home, 'runs'))).toEqual([]);
  });
  it('rejects a healthy URL that belongs to a different worker and stops Caddy', async () => {
    const s = await setup();
    s.fetchImpl.mockImplementation(async () => new Response(JSON.stringify({ ok: true, instance: 'wrong-agent' })));
    await expect(startDesktopGateway(3000, { ...s, timeoutMs: 5 })).rejects.toThrow('could not reach this agent');
    expect(s.child.kill).toHaveBeenCalled();
    expect(await readdir(join(s.home, 'runs'))).toEqual([]);
  });
  it('reports native process startup failures and cleans its generated configuration', async () => {
    const s = await setup();
    vi.mocked(s.spawnImpl).mockImplementation(() => {
      queueMicrotask(() => { s.child.emit('error', new Error('blocked')); s.child.emit('close', 1); });
      return s.child;
    });
    await expect(startDesktopGateway(3000, { ...s, timeoutMs: 5 })).rejects.toThrow('could not start');
    expect(await readdir(join(s.home, 'runs'))).toEqual([]);
  });
});
