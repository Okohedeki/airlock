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

  it('scaffolds a harness-backed agentic service with --agent', async () => {
    const result = await runInit({ cwd, name: 'my-analyst', target: 'fly', harness: 'langgraph' });
    expect(result.agentPaths?.length).toBeGreaterThan(0);
    const app = await readFile(join(cwd, 'app.py'), 'utf8');
    expect(app).toContain('from airlock_agent import serve');
    const reqs = await readFile(join(cwd, 'requirements.txt'), 'utf8');
    expect(reqs).toContain('langgraph');
    expect(reqs).toContain('airlock-agent');
    await expect(readFile(join(cwd, 'adapter.py'), 'utf8')).resolves.toContain('AgentRunResult');
  });

  it('rejects --agent on a non-fly target (ADR-0003)', async () => {
    await expect(
      runInit({ cwd, name: 'x', target: 'workers', harness: 'smolagents' }),
    ).rejects.toThrow(/requires --target=fly/);
  });

  it('--detect scans the repo and writes the [agent] block + runtime Dockerfile', async () => {
    const { writeFile: wf } = await import('node:fs/promises');
    await wf(join(cwd, 'requirements.txt'), 'langgraph>=0.2\n');
    await wf(join(cwd, 'agents.py'), 'def build_agent():\n    return object()\n');
    const result = await runInit({ cwd, name: 'my-analyst', target: 'fly', detect: true });
    expect(result.detected?.harness).toBe('langgraph');
    expect(result.detected?.entrypoint).toBe('agents:build_agent');
    const cfg = parse(await readFile(result.configPath, 'utf8')) as {
      agent: { harness: string; entrypoint: string };
    };
    expect(cfg.agent).toEqual({ harness: 'langgraph', entrypoint: 'agents:build_agent' });
    const docker = await readFile(join(cwd, 'Dockerfile'), 'utf8');
    expect(docker).toContain('python", "-m", "airlock_agent');
    // airlock runtime is vendored + pip-installed from local source (Blocker 0:
    // the packages aren't on PyPI), not listed as a bare requirement.
    expect(docker).toContain('/app/.airlock/vendor/payment-fly');
    expect(docker).toContain('/app/.airlock/vendor/agent-runtime');
    const reqs = await readFile(join(cwd, 'requirements.txt'), 'utf8');
    expect(reqs).not.toMatch(/^airlock-agent\b/m);
    // Both packages were copied into the build context with their pyproject.
    await expect(
      readFile(join(cwd, '.airlock/vendor/agent-runtime/pyproject.toml'), 'utf8'),
    ).resolves.toContain('name = "airlock-agent"');
    await expect(
      readFile(join(cwd, '.airlock/vendor/payment-fly/pyproject.toml'), 'utf8'),
    ).resolves.toContain('name = "airlock-payment"');
  });

  it('--self-host writes mode=self-hosted and skips the cloud Recipe', async () => {
    const result = await runInit({ cwd, name: 'box-agent', target: 'fly', mode: 'self-hosted' });
    expect(result.recipePath).toBeUndefined();
    const parsed = parse(await readFile(result.configPath, 'utf8')) as {
      project: { mode?: string };
    };
    expect(parsed.project.mode).toBe('self-hosted');
    // No fly.toml for the hardware self-host path.
    await expect(readFile(join(cwd, 'fly.toml'), 'utf8')).rejects.toThrow();
  });

  it('--detect strips an unresolvable bare airlock-agent line from requirements', async () => {
    const { writeFile: wf } = await import('node:fs/promises');
    await wf(join(cwd, 'requirements.txt'), 'smolagents==1.25.*\nairlock-agent\nairlock-payment\n');
    await wf(join(cwd, 'agents.py'), 'from smolagents import CodeAgent\nagent = CodeAgent()\n');
    await runInit({ cwd, name: 'x', target: 'fly', detect: true });
    const reqs = await readFile(join(cwd, 'requirements.txt'), 'utf8');
    expect(reqs).toContain('smolagents');
    expect(reqs).not.toMatch(/^airlock-agent\b/m);
    expect(reqs).not.toMatch(/^airlock-payment\b/m);
  });
});
