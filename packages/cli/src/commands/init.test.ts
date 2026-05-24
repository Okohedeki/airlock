import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from './init.js';

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'airlock-cli-init-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('runInit', () => {
  it('writes a valid config.toml with project + payment scaffold', async () => {
    const result = await runInit({ cwd, name: 'my-agent', target: 'fly' });
    const raw = await readFile(result.configPath, 'utf8');
    const parsed = parse(raw) as {
      project: { name: string; target: string; schemaVersion: number };
      payment: { enabled: boolean; wallet: string; network: string };
    };
    expect(parsed.project.name).toBe('my-agent');
    expect(parsed.project.target).toBe('fly');
    expect(parsed.project.schemaVersion).toBe(1);
    expect(parsed.payment.enabled).toBe(false);
    expect(parsed.payment.network).toBe('base-sepolia');
    expect(parsed.payment.wallet).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it('scaffolds a wrangler.toml when target is workers', async () => {
    const result = await runInit({ cwd, name: 'my-worker', target: 'workers' });
    expect(result.recipePath).toMatch(/wrangler\.toml$/);
    if (!result.recipePath) throw new Error('recipePath missing');
    const raw = await readFile(result.recipePath, 'utf8');
    expect(raw).toContain('name = "my-worker"');
    expect(raw).toContain('main = "src/index.ts"');
  });

  it('scaffolds a fly.toml when target is fly', async () => {
    const result = await runInit({ cwd, name: 'my-fly-app', target: 'fly' });
    expect(result.recipePath).toMatch(/fly\.toml$/);
    if (!result.recipePath) throw new Error('recipePath missing');
    const raw = await readFile(result.recipePath, 'utf8');
    expect(raw).toContain('app = "my-fly-app"');
    expect(raw).toContain('internal_port = 3000');
  });

  it('skips Recipe scaffold when scaffoldRecipe is false', async () => {
    const result = await runInit({ cwd, name: 'x', target: 'fly', scaffoldRecipe: false });
    expect(result.recipePath).toBeUndefined();
  });
});
