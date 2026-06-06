import { describe, expect, it } from 'vitest';
import type { AirlockConfig } from '../config-file.js';
import { resolveDurableTunnel, resolveTunnelTuning, resolveUpPlan } from './up.js';

const base: AirlockConfig = {
  project: { name: 'a', target: 'fly', mode: 'self-hosted', schemaVersion: 1 },
  agent: { harness: 'smolagents', entrypoint: 'pkg.agent:build_agent' },
};

describe('resolveUpPlan', () => {
  it('throws when there is neither a worker.yaml nor an [agent] block', () => {
    const cfg = { ...base, agent: undefined };
    expect(() => resolveUpPlan(cfg)).toThrow(/worker\.yaml|\[agent\] block|config-bound agent/i);
  });

  it('maps the port and runtime args', () => {
    const plan = resolveUpPlan(base, { port: 4000 });
    expect(plan.env.PORT).toBe('4000');
    expect(plan.args).toEqual(['-m', 'airlock_agent']);
  });

  it('defaults port to 3000 and python to python3', () => {
    const prev = process.env.AIRLOCK_PYTHON;
    delete process.env.AIRLOCK_PYTHON;
    const plan = resolveUpPlan(base);
    expect(plan.port).toBe(3000);
    expect(plan.env.PORT).toBe('3000');
    expect(plan.python).toBe('python3');
    if (prev !== undefined) process.env.AIRLOCK_PYTHON = prev;
  });

  it('honors an explicit python override', () => {
    const plan = resolveUpPlan(base, { python: '/tmp/venv/bin/python' });
    expect(plan.python).toBe('/tmp/venv/bin/python');
  });

  it('maps concurrency options to AIRLOCK_* env vars', () => {
    const plan = resolveUpPlan(base, {
      maxConcurrency: 8,
      maxQueue: 100,
      queueTimeout: 15,
      buildPerCall: false,
    });
    expect(plan.env.AIRLOCK_MAX_CONCURRENCY).toBe('8');
    expect(plan.env.AIRLOCK_MAX_QUEUE).toBe('100');
    expect(plan.env.AIRLOCK_QUEUE_TIMEOUT_S).toBe('15');
    expect(plan.env.AIRLOCK_BUILD_PER_CALL).toBe('0');
  });

  it('omits concurrency env when not set (runtime keeps its own defaults)', () => {
    const plan = resolveUpPlan(base);
    expect(plan.env.AIRLOCK_MAX_CONCURRENCY).toBeUndefined();
    expect(plan.env.AIRLOCK_MAX_QUEUE).toBeUndefined();
    expect(plan.env.AIRLOCK_QUEUE_TIMEOUT_S).toBeUndefined();
    expect(plan.env.AIRLOCK_BUILD_PER_CALL).toBeUndefined();
  });
});

describe('resolveDurableTunnel', () => {
  const host = 'agent.example.com';
  const token = 'eyJhIjoidG9rZW4ifQ==';

  it('returns null when durable mode is not requested', () => {
    expect(resolveDurableTunnel(base, {}, {})).toBeNull();
    const withTunnelOff: AirlockConfig = { ...base, tunnel: { durable: false } };
    expect(resolveDurableTunnel(withTunnelOff, {}, {})).toBeNull();
  });

  it('returns BYO token + hostname when durable via --durable and creds present', () => {
    const cfg: AirlockConfig = { ...base, tunnel: { hostname: host } };
    const out = resolveDurableTunnel(cfg, { durable: true }, { AIRLOCK_CF_TUNNEL_TOKEN: token });
    expect(out).toEqual({ token, hostname: host });
  });

  it('honors [tunnel].durable=true from config', () => {
    const cfg: AirlockConfig = { ...base, tunnel: { durable: true, hostname: host } };
    const out = resolveDurableTunnel(cfg, {}, { AIRLOCK_CF_TUNNEL_TOKEN: token });
    expect(out).toEqual({ token, hostname: host });
  });

  it('throws an actionable error when the token env var is missing', () => {
    const cfg: AirlockConfig = { ...base, tunnel: { durable: true, hostname: host } };
    expect(() => resolveDurableTunnel(cfg, {}, {})).toThrow(/AIRLOCK_CF_TUNNEL_TOKEN/);
    expect(() => resolveDurableTunnel(cfg, {}, {})).toThrow(/docs\/durable-hosting\.md/);
  });

  it('throws when the hostname is missing', () => {
    const cfg: AirlockConfig = { ...base, tunnel: { durable: true } };
    expect(() => resolveDurableTunnel(cfg, {}, { AIRLOCK_CF_TUNNEL_TOKEN: token })).toThrow(
      /tunnel\.hostname|hostname/i,
    );
  });

  it('rejects an unknown [tunnel] key with a readable message', () => {
    const cfg: AirlockConfig = { ...base, tunnel: { durable: true, hostname: host, bogus: 1 } };
    expect(() => resolveDurableTunnel(cfg, {}, { AIRLOCK_CF_TUNNEL_TOKEN: token })).toThrow(
      /invalid \[tunnel\] config/,
    );
  });
});

describe('resolveTunnelTuning', () => {
  it('returns undefined when nothing is configured', () => {
    expect(resolveTunnelTuning(base, {})).toBeUndefined();
  });

  it('reads protocol/region/metrics from the [tunnel] block', () => {
    const cfg: AirlockConfig = {
      ...base,
      tunnel: { protocol: 'quic', region: 'us', metrics: 'localhost:9000' },
    };
    expect(resolveTunnelTuning(cfg, {})).toEqual({
      protocol: 'quic',
      region: 'us',
      metrics: 'localhost:9000',
    });
  });

  it('lets CLI options override the config block', () => {
    const cfg: AirlockConfig = { ...base, tunnel: { protocol: 'http2', region: 'us' } };
    expect(resolveTunnelTuning(cfg, { cfProtocol: 'quic', cfMetrics: '0.0.0.0:9' })).toEqual({
      protocol: 'quic',
      region: 'us',
      metrics: '0.0.0.0:9',
    });
  });
});
