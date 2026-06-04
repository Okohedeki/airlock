import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeConfig } from './config-file.js';
import { configToWorkerYaml, runMigrate } from './migrate.js';

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'airlock-cli-migrate-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('configToWorkerYaml', () => {
  it('maps project + agent and never emits payment', () => {
    const yaml = configToWorkerYaml({
      project: { name: 'demo', target: 'fly', schemaVersion: 1 },
      agent: { harness: 'langgraph', entrypoint: 'agent:build_agent' },
    });
    expect(yaml).toContain('name: "demo"');
    expect(yaml).toContain('harness: "langgraph"');
    expect(yaml).toContain('entrypoint: "agent:build_agent"');
    expect(yaml).toContain('expose: internal');
    expect(yaml).not.toMatch(/payment|wallet|usdc/i);
  });

  it('maps a durable tunnel to expose: public', () => {
    const yaml = configToWorkerYaml({
      project: { name: 'demo', target: 'fly', schemaVersion: 1 },
      tunnel: { durable: true, hostname: 'agent.example.com' },
    });
    expect(yaml).toContain('expose: public');
    expect(yaml).toContain('hostname: "agent.example.com"');
  });
});

describe('runMigrate', () => {
  it('writes worker.yaml from .airlock/config.toml', async () => {
    await writeConfig(cwd, {
      project: { name: 'demo', target: 'fly', schemaVersion: 1 },
      agent: { harness: 'smolagents', entrypoint: 'agent:build_agent' },
    });
    const result = await runMigrate({ cwd });
    expect(result.workerPath).toMatch(/worker\.yaml$/);
    const raw = await readFile(result.workerPath, 'utf8');
    expect(raw).toContain('name: "demo"');
    expect(raw).not.toMatch(/payment/i);
  });
});
