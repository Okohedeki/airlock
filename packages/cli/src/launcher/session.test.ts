import { describe, expect, it, vi } from 'vitest';
import { agentSession } from './session.js';
import type { runUp } from '../commands/up.js';

const agent = { id: 'example', name: 'Example', harness: 'stub', directory: '/missing-agent', location: 'example' };
const access = { operator: 'a'.repeat(64), caller: 'b'.repeat(64) };

function setup() {
  let finish!: (code: number) => void;
  const done = new Promise<number>(resolve => { finish = resolve; });
  const stop = vi.fn(async () => { finish(0); });
  const run = vi.fn(async () => ({ url: 'http://127.0.0.1:3030', done, stop }));
  const session = agentSession([agent], { runImpl: run as unknown as typeof runUp, accessImpl: async () => access });
  return { session, run, stop, finish };
}

describe('agent launcher lifecycle', () => {
  it('keeps credentials out of status and supplies them to the worker automatically', async () => {
    const { session, run } = setup();
    await session.start(agent.id, true);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ cwd: agent.directory, noTunnel: true, access }));
    expect(session.state().status).toBe('running');
    expect(JSON.stringify(session.state())).not.toContain(access.operator);
    expect(JSON.stringify(session.state())).not.toContain(agent.directory);
    const link = new URL(session.consoleLink());
    expect(new URLSearchParams(link.hash.slice(1)).get('operator')).toBe(access.operator);
    await session.stop();
  });
  it('refuses a public launch without infrastructure instead of returning a local URL', async () => {
    const { session, run } = setup();
    await expect(session.start(agent.id, false)).rejects.toThrow('Connect your relay once');
    expect(run).not.toHaveBeenCalled();
    expect(session.state().active).toBeNull();
  });
  it('prevents duplicate workers and stops the current worker once', async () => {
    const { session, run, stop } = setup();
    await session.start(agent.id, true);
    await expect(session.start(agent.id, true)).rejects.toThrow('already active');
    expect(run).toHaveBeenCalledTimes(1);
    await session.stop();
    await session.stop();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(session.state().status).toBe('idle');
    expect(() => session.consoleLink()).toThrow('Start an agent first');
  });
  it('clears the link when the worker exits unexpectedly', async () => {
    const { session, finish } = setup();
    await session.start(agent.id, true);
    finish(1);
    await Promise.resolve();
    expect(session.state()).toMatchObject({ status: 'error', active: null });
  });
  it('recovers after a failed startup', async () => {
    const { session, run } = setup();
    run.mockRejectedValueOnce(new Error('Port is already in use'));
    await expect(session.start(agent.id, true)).rejects.toThrow('Port is already in use');
    expect(session.state()).toMatchObject({ status: 'error', active: null });
    await session.start(agent.id, true);
    expect(session.state().status).toBe('running');
    await session.stop();
  });
});
