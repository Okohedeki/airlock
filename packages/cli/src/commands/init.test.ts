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

  it('does not scaffold a starter agent by default', async () => {
    const result = await runInit({ cwd, name: 'x', target: 'fly' });
    expect(result.agentPaths).toBeUndefined();
  });

  it('scaffolds a runnable fly-node starter agent with --with-agent', async () => {
    const result = await runInit({ cwd, name: 'my-agent', target: 'fly', withAgent: true });
    expect(result.agentPaths?.length).toBeGreaterThan(0);
    const server = await readFile(join(cwd, 'src/server.ts'), 'utf8');
    expect(server).toContain("withPaymentExpress");
    expect(server).toContain("'/run'");
    const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as {
      name: string;
      dependencies: Record<string, string>;
    };
    expect(pkg.name).toBe('my-agent');
    expect(pkg.dependencies['@airlockhq/payment-fly-node']).toBeTruthy();
    // Dockerfile present for containerized deploy
    await expect(readFile(join(cwd, 'Dockerfile'), 'utf8')).resolves.toContain('EXPOSE 3000');
  });

  it('scaffolds a workers starter agent with --with-agent --target=workers', async () => {
    const result = await runInit({ cwd, name: 'my-worker', target: 'workers', withAgent: true });
    expect(result.agentPaths?.length).toBeGreaterThan(0);
    const index = await readFile(join(cwd, 'src/index.ts'), 'utf8');
    expect(index).toContain('withPayment');
    expect(index).toContain('X-Airlock-Units');
  });

  it('warms one machine by default in the fly recipe (cold-start fix)', async () => {
    const result = await runInit({ cwd, name: 'warm', target: 'fly' });
    if (!result.recipePath) throw new Error('recipePath missing');
    const raw = await readFile(result.recipePath, 'utf8');
    expect(raw).toContain('min_machines_running = 1');
  });
});
