import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeConfig } from '../config-file.js';
import { runDoctor } from './doctor.js';

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'airlock-cli-doctor-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const REAL_WALLET = '0x1234567890abcdef1234567890abcdef12345678';

describe('runDoctor', () => {
  it('errors when no config file exists', async () => {
    const report = await runDoctor(cwd);
    expect(report.ok).toBe(false);
    expect(report.findings[0]?.level).toBe('error');
    expect(report.findings[0]?.message).toMatch(/no .airlock-deploy\/config.toml/);
  });

  it('passes on a valid config with a real wallet and payment disabled', async () => {
    await writeConfig(cwd, {
      project: { name: 'a', target: 'fly', schemaVersion: 1 },
      payment: {
        enabled: false,
        wallet: REAL_WALLET,
        network: 'base-sepolia',
        facilitatorUrl: 'https://facilitator.x402.org',
        description: 'x',
        mode: 'flat',
        priceUsdc: '0.001',
      },
    });
    const report = await runDoctor(cwd);
    expect(report.ok).toBe(true);
  });

  it('flags the placeholder wallet as an error when payment is enabled', async () => {
    await writeConfig(cwd, {
      project: { name: 'a', target: 'fly', schemaVersion: 1 },
      payment: {
        enabled: true,
        wallet: '0x0000000000000000000000000000000000000001',
        network: 'base-sepolia',
        facilitatorUrl: 'https://facilitator.x402.org',
        description: 'x',
        mode: 'flat',
        priceUsdc: '0.001',
      },
    });
    const report = await runDoctor(cwd);
    expect(report.ok).toBe(false);
    expect(
      report.findings.some((f) => f.level === 'error' && f.message.includes('placeholder')),
    ).toBe(true);
  });

  it('reports Zod errors for invalid payment config', async () => {
    await writeConfig(cwd, {
      project: { name: 'a', target: 'fly', schemaVersion: 1 },
      payment: {
        enabled: true,
        wallet: 'not-an-address',
        network: 'base-sepolia',
        mode: 'flat',
        priceUsdc: '0.001',
      },
    });
    const report = await runDoctor(cwd);
    expect(report.ok).toBe(false);
    expect(
      report.findings.some((f) => f.level === 'error' && f.message.startsWith('payment.')),
    ).toBe(true);
  });

  it('errors on unknown schemaVersion or target', async () => {
    await writeConfig(cwd, {
      project: { name: 'a', target: 'beanstalk' as 'fly', schemaVersion: 99 as 1 },
    });
    const report = await runDoctor(cwd);
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.message.includes('schemaVersion'))).toBe(true);
    expect(report.findings.some((f) => f.message.includes('target'))).toBe(true);
  });

  it('warns (not errors) when payment section is absent', async () => {
    await writeConfig(cwd, { project: { name: 'a', target: 'fly', schemaVersion: 1 } });
    const report = await runDoctor(cwd);
    expect(report.ok).toBe(true);
    expect(report.findings.some((f) => f.level === 'warn')).toBe(true);
  });
});
