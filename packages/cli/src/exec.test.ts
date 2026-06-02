import { describe, expect, it } from 'vitest';
import type { AirlockConfig } from './config-file.js';
import { buildDelete, buildDeploy, buildDomain, buildLogs, buildSecret } from './exec.js';

const workersConfig: AirlockConfig = {
  project: { name: 'my-worker', target: 'workers', schemaVersion: 1 },
};

describe('buildDeploy', () => {
  it('workers → wrangler deploy', () => {
    expect(buildDeploy(workersConfig)).toEqual({ binary: 'wrangler', args: ['deploy'] });
  });
});

describe('buildDelete', () => {
  it('workers → wrangler delete', () => {
    expect(buildDelete(workersConfig)).toEqual({ binary: 'wrangler', args: ['delete'] });
  });
});

describe('buildLogs', () => {
  it('workers → wrangler tail', () => {
    expect(buildLogs(workersConfig)).toEqual({ binary: 'wrangler', args: ['tail'] });
  });
});

describe('buildSecret', () => {
  it('set NAME=VAL → wrangler secret put NAME (value via stdin)', () => {
    expect(buildSecret(workersConfig, 'set', 'OPENAI_API_KEY=sk-xxx')).toEqual({
      binary: 'wrangler',
      args: ['secret', 'put', 'OPENAI_API_KEY'],
    });
  });
  it('list', () => {
    expect(buildSecret(workersConfig, 'list')).toEqual({
      binary: 'wrangler',
      args: ['secret', 'list'],
    });
  });
  it('rm', () => {
    expect(buildSecret(workersConfig, 'rm', 'OPENAI_API_KEY')).toEqual({
      binary: 'wrangler',
      args: ['secret', 'delete', 'OPENAI_API_KEY'],
    });
  });
  it('set without name throws', () => {
    expect(() => buildSecret(workersConfig, 'set', '')).toThrow(/NAME=VALUE/);
  });
  it('rm without name throws', () => {
    expect(() => buildSecret(workersConfig, 'rm')).toThrow(/NAME/);
  });
});

describe('buildDomain', () => {
  it('add', () => {
    expect(buildDomain(workersConfig, 'add', 'api.example.com')).toEqual({
      binary: 'wrangler',
      args: ['domains', 'add', 'api.example.com'],
    });
  });
  it('rm', () => {
    expect(buildDomain(workersConfig, 'rm', 'api.example.com')).toEqual({
      binary: 'wrangler',
      args: ['domains', 'remove', 'api.example.com'],
    });
  });
  it('empty hostname throws', () => {
    expect(() => buildDomain(workersConfig, 'add', '')).toThrow(/HOSTNAME/);
  });
});
