import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { describe, it, expect, vi } from 'vitest';
import { startRelay } from './relay.js';
import { relaySchema } from './relay-config.js';

const config = relaySchema.parse({ hostname: 'agent.example.com', serverAddr: 'relay.example.com', caFile: 'ca.pem' });
const env = { AIRLOCK_RELAY_TOKEN: 'a'.repeat(64), OPENAI_API_KEY: 'private-model-key' };

function connector() {
  const child = new EventEmitter() as ChildProcess;
  child.kill = vi.fn(() => { child.emit('close', 0); return true; });
  const launch = vi.fn(() => child);
  return { child, launch, spawnImpl: launch as unknown as typeof spawn };
}

describe('native relay lifecycle', () => {
  it('checks the public launch identity and strips unrelated secrets', async () => {
    const fake = connector();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, instance: 'this-launch' })));
    const handle = await startRelay(3000, { config, env, instance: 'this-launch', spawnImpl: fake.spawnImpl, fetchImpl });
    expect(handle.url).toBe('https://agent.example.com');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://agent.example.com/healthz');
    const args = fake.launch.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv; windowsHide: boolean }];
    expect(args[2].windowsHide).toBe(true);
    expect(args[2].env.OPENAI_API_KEY).toBeUndefined();
    expect(await readFile(args[1][1]!, 'utf8')).not.toContain(env.AIRLOCK_RELAY_TOKEN);
    handle.stop();
    expect(await handle.done).toBe(0);
    await vi.waitFor(async () => { await expect(access(args[1][1]!)).rejects.toThrow(); });
  });

  it.each(['wrong-worker', undefined])('rejects a healthy but unrelated public endpoint (%s)', async (instance) => {
    const fake = connector();
    await expect(startRelay(3000, {
      config, env, instance: 'this-launch', spawnImpl: fake.spawnImpl, timeoutMs: 15,
      fetchImpl: async () => new Response(JSON.stringify({ ok: true, instance })),
    })).rejects.toThrow(/did not reach this worker/);
    expect(fake.child.kill).toHaveBeenCalledOnce();
  });

  it('rejects missing credentials before launching a connector', async () => {
    const fake = connector();
    await expect(startRelay(3000, { config, env: {}, instance: 'launch', spawnImpl: fake.spawnImpl })).rejects.toThrow(/AIRLOCK_RELAY_TOKEN/);
    expect(fake.launch).not.toHaveBeenCalled();
  });

  it('cleans up a connector that exits during startup', async () => {
    const fake = connector();
    await expect(startRelay(3000, {
      config, env, instance: 'launch', spawnImpl: fake.spawnImpl,
      fetchImpl: async () => {
        fake.child.emit('close', 9);
        return new Response(JSON.stringify({ ok: true, instance: 'launch' }));
      },
    })).rejects.toThrow(/code 9/);
  });
});
