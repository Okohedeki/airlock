import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeConfig } from '../config-file.js';
import { runStatus } from './status.js';

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'airlock-cli-status-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('runStatus', () => {
  it('reports project + payment summary', async () => {
    await writeConfig(cwd, {
      project: { name: 'demo', target: 'workers', schemaVersion: 1 },
      payment: {
        enabled: true,
        wallet: '0x1234567890abcdef1234567890abcdef12345678',
        network: 'base',
        facilitatorUrl: 'https://facilitator.x402.org',
        description: 'x',
        mode: 'flat',
        priceUsdc: '0.01',
      },
    });
    const summary = await runStatus(cwd);
    expect(summary.project).toEqual({ name: 'demo', target: 'workers' });
    expect(summary.payment).toMatchObject({
      configured: true,
      enabled: true,
      mode: 'flat',
      network: 'base',
    });
  });

  it('reports payment.configured=false when section is absent', async () => {
    await writeConfig(cwd, { project: { name: 'demo', target: 'fly', schemaVersion: 1 } });
    const summary = await runStatus(cwd);
    expect(summary.payment).toEqual({ configured: false });
  });

  it('reports payment.configured=false when section is malformed', async () => {
    await writeConfig(cwd, {
      project: { name: 'demo', target: 'fly', schemaVersion: 1 },
      payment: { wallet: 'not-an-address', mode: 'flat' },
    });
    const summary = await runStatus(cwd);
    expect(summary.payment).toEqual({ configured: false });
  });
});
