import { describe, expect, it } from 'vitest';
import type { AirlockConfig } from '../config-file.js';
import { resolveUpPlan } from './up.js';

const base: AirlockConfig = {
  project: { name: 'a', target: 'fly', mode: 'self-hosted', schemaVersion: 1 },
  agent: { harness: 'smolagents', entrypoint: 'pkg.agent:build_agent' },
};

describe('resolveUpPlan', () => {
  it('throws when there is no [agent] block', () => {
    const cfg = { ...base, agent: undefined };
    expect(() => resolveUpPlan(cfg)).toThrow(/no \[agent\] block|config-bound agent/i);
  });

  it('maps a flat payment block to the runtime env vars', () => {
    const cfg: AirlockConfig = {
      ...base,
      payment: {
        enabled: true,
        wallet: '0x00000000000000000000000000000000000000aa',
        network: 'base',
        mode: 'flat',
        priceUsdc: '0.01',
      },
    };
    const plan = resolveUpPlan(cfg, { port: 4000 });
    expect(plan.env.PORT).toBe('4000');
    expect(plan.env.PAYMENT_ENABLED).toBe('1');
    expect(plan.env.PUBLISHER_WALLET).toBe('0x00000000000000000000000000000000000000aa');
    expect(plan.env.PAYMENT_NETWORK).toBe('base');
    expect(plan.env.PRICE_USDC).toBe('0.01');
    expect(plan.args).toEqual(['-m', 'airlock_agent']);
  });

  it('disables payment with noPayment regardless of config', () => {
    const cfg: AirlockConfig = {
      ...base,
      payment: { enabled: true, wallet: '0x1', network: 'base', mode: 'flat', priceUsdc: '0.01' },
    };
    const plan = resolveUpPlan(cfg, { noPayment: true });
    expect(plan.env.PAYMENT_ENABLED).toBe('0');
    expect(plan.env.PUBLISHER_WALLET).toBeUndefined();
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
});
