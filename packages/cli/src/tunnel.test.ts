import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { cfOptions, type Connector, startNamedTunnel } from './tunnel.js';

describe('cfOptions', () => {
  it('maps tuning to cloudflared flags, omitting unset ones', () => {
    expect(cfOptions({})).toEqual({});
    expect(cfOptions({ protocol: 'quic', region: 'us', metrics: 'localhost:9000' })).toEqual({
      '--protocol': 'quic',
      '--region': 'us',
      '--metrics': 'localhost:9000',
    });
    expect(cfOptions({ region: 'us' })).toEqual({ '--region': 'us' });
  });
});

class FakeConnector extends EventEmitter implements Connector {
  stopped = false;
  options: Record<string, string | number | boolean>;
  constructor(options: Record<string, string | number | boolean>) {
    super();
    this.options = options;
  }
  stop(): void {
    this.stopped = true;
  }
}

function factoryRecording() {
  const made: FakeConnector[] = [];
  const factory = (_token: string, options: Record<string, string | number | boolean>) => {
    const c = new FakeConnector(options);
    made.push(c);
    return c;
  };
  return { made, factory };
}

describe('startNamedTunnel supervision', () => {
  it('resolves on first connect and reports the stable hostname', async () => {
    const { made, factory } = factoryRecording();
    const p = startNamedTunnel(3000, {
      token: 't',
      hostname: 'agent.example.com',
      connectorFactory: factory,
      backoffMs: () => 1,
    });
    // let the awaited promise register its listeners, then connect
    await Promise.resolve();
    made[0].emit('connected');
    const handle = await p;
    expect(handle.url).toBe('https://agent.example.com');
    expect(made[0].options).toEqual({});
  });

  it('passes tuning flags through to the connector', async () => {
    const { made, factory } = factoryRecording();
    const p = startNamedTunnel(3000, {
      token: 't',
      hostname: 'agent.example.com',
      tuning: { protocol: 'quic', metrics: 'localhost:9000' },
      connectorFactory: factory,
    });
    await Promise.resolve();
    made[0].emit('connected');
    await p;
    expect(made[0].options).toEqual({ '--protocol': 'quic', '--metrics': 'localhost:9000' });
  });

  it('respawns the connector on an unexpected exit (reconnect, same URL)', async () => {
    const { made, factory } = factoryRecording();
    const p = startNamedTunnel(3000, {
      token: 't',
      hostname: 'agent.example.com',
      connectorFactory: factory,
      backoffMs: () => 1,
    });
    await Promise.resolve();
    made[0].emit('connected');
    await p;

    // crash → after the (tiny) backoff a fresh connector is spawned
    made[0].emit('exit', 1);
    await vi.waitFor(() => expect(made.length).toBe(2));
  });

  it('stop() prevents any further respawn', async () => {
    const { made, factory } = factoryRecording();
    const p = startNamedTunnel(3000, {
      token: 't',
      hostname: 'agent.example.com',
      connectorFactory: factory,
      backoffMs: () => 1,
    });
    await Promise.resolve();
    made[0].emit('connected');
    const handle = await p;

    handle.stop();
    expect(made[0].stopped).toBe(true);
    made[0].emit('exit', 0); // simulate the process going away after stop
    // give any (incorrect) scheduled respawn a chance to fire
    await new Promise((r) => setTimeout(r, 10));
    expect(made.length).toBe(1);
  });

  it('rejects fast when the first connect fails (no silent retry)', async () => {
    const { made, factory } = factoryRecording();
    const p = startNamedTunnel(3000, {
      token: 't',
      hostname: 'agent.example.com',
      connectorFactory: factory,
      backoffMs: () => 1,
    });
    await Promise.resolve();
    made[0].emit('exit', 7); // died before connecting
    await expect(p).rejects.toThrow(/exited before connecting/);
    // and it did not start respawning
    await new Promise((r) => setTimeout(r, 10));
    expect(made.length).toBe(1);
  });
});
