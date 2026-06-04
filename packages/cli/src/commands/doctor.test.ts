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

describe('runDoctor', () => {
  it('errors when no config file exists', async () => {
    const report = await runDoctor(cwd);
    expect(report.ok).toBe(false);
    expect(report.findings[0]?.level).toBe('error');
    expect(report.findings[0]?.message).toMatch(/no worker\.yaml or .airlock\/config\.toml/);
  });

  it('passes on a valid config', async () => {
    await writeConfig(cwd, {
      project: { name: 'a', target: 'workers', schemaVersion: 1 },
    });
    const report = await runDoctor(cwd);
    expect(report.ok).toBe(true);
  });

  it('accepts both workers and fly as targets', async () => {
    await writeConfig(cwd, { project: { name: 'a', target: 'fly', schemaVersion: 1 } });
    const report = await runDoctor(cwd);
    expect(report.ok).toBe(true);
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

  describe('durable tunnel credential clarity', () => {
    const TOKEN_ENV = 'AIRLOCK_CF_TUNNEL_TOKEN';
    let prevToken: string | undefined;

    beforeEach(() => {
      prevToken = process.env[TOKEN_ENV];
      delete process.env[TOKEN_ENV];
    });
    afterEach(() => {
      if (prevToken === undefined) delete process.env[TOKEN_ENV];
      else process.env[TOKEN_ENV] = prevToken;
    });

    it('errors and names the missing token when durable=true but env unset', async () => {
      await writeConfig(cwd, {
        project: { name: 'a', target: 'workers', schemaVersion: 1 },
        tunnel: { durable: true, hostname: 'agent.example.com' },
      });
      const report = await runDoctor(cwd);
      expect(report.ok).toBe(false);
      expect(
        report.findings.some((f) => f.level === 'error' && f.message.includes(TOKEN_ENV)),
      ).toBe(true);
    });

    it('errors when durable=true but hostname is unset', async () => {
      process.env[TOKEN_ENV] = 'tok';
      await writeConfig(cwd, {
        project: { name: 'a', target: 'workers', schemaVersion: 1 },
        tunnel: { durable: true },
      });
      const report = await runDoctor(cwd);
      expect(report.ok).toBe(false);
      expect(report.findings.some((f) => f.level === 'error' && /hostname/i.test(f.message))).toBe(
        true,
      );
    });

    it('reports ready when both the token env and hostname are present', async () => {
      process.env[TOKEN_ENV] = 'tok';
      await writeConfig(cwd, {
        project: { name: 'a', target: 'workers', schemaVersion: 1 },
        tunnel: { durable: true, hostname: 'agent.example.com' },
      });
      const report = await runDoctor(cwd);
      expect(report.ok).toBe(true);
      expect(
        report.findings.some((f) => f.level === 'ok' && /durable tunnel ready/i.test(f.message)),
      ).toBe(true);
    });

    it('notes the ephemeral quick tunnel when durable=false', async () => {
      await writeConfig(cwd, {
        project: { name: 'a', target: 'workers', schemaVersion: 1 },
        tunnel: { durable: false },
      });
      const report = await runDoctor(cwd);
      expect(report.ok).toBe(true);
      expect(report.findings.some((f) => f.level === 'ok' && /quick tunnel/i.test(f.message))).toBe(
        true,
      );
    });
  });
});
