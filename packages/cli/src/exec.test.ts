import { describe, expect, it } from 'vitest';
import type { AirlockConfig } from './config-file.js';
import { buildDelete, buildDeploy, buildDev, buildDomain, buildLogs, buildSecret } from './exec.js';

const flyConfig: AirlockConfig = {
  project: { name: 'my-agent', target: 'fly', schemaVersion: 1 },
};
const workersConfig: AirlockConfig = {
  project: { name: 'my-worker', target: 'workers', schemaVersion: 1 },
};

describe('buildDeploy', () => {
  it('workers → wrangler deploy', () => {
    expect(buildDeploy(workersConfig)).toEqual({ binary: 'wrangler', args: ['deploy'] });
  });
  it('fly → fly deploy --app NAME', () => {
    expect(buildDeploy(flyConfig)).toEqual({
      binary: 'fly',
      args: ['deploy', '--app', 'my-agent'],
    });
  });
});

describe('buildDelete', () => {
  it('workers → wrangler delete', () => {
    expect(buildDelete(workersConfig)).toEqual({ binary: 'wrangler', args: ['delete'] });
  });
  it('fly → fly apps destroy NAME --yes', () => {
    expect(buildDelete(flyConfig)).toEqual({
      binary: 'fly',
      args: ['apps', 'destroy', 'my-agent', '--yes'],
    });
  });
});

describe('buildLogs', () => {
  it('workers → wrangler tail', () => {
    expect(buildLogs(workersConfig)).toEqual({ binary: 'wrangler', args: ['tail'] });
  });
  it('fly → fly logs --app NAME', () => {
    expect(buildLogs(flyConfig)).toEqual({
      binary: 'fly',
      args: ['logs', '--app', 'my-agent'],
    });
  });
});

describe('buildSecret', () => {
  it('workers set NAME=VAL → wrangler secret put NAME (value via stdin)', () => {
    expect(buildSecret(workersConfig, 'set', 'OPENAI_API_KEY=sk-xxx')).toEqual({
      binary: 'wrangler',
      args: ['secret', 'put', 'OPENAI_API_KEY'],
    });
  });
  it('workers list', () => {
    expect(buildSecret(workersConfig, 'list')).toEqual({
      binary: 'wrangler',
      args: ['secret', 'list'],
    });
  });
  it('workers rm', () => {
    expect(buildSecret(workersConfig, 'rm', 'OPENAI_API_KEY')).toEqual({
      binary: 'wrangler',
      args: ['secret', 'delete', 'OPENAI_API_KEY'],
    });
  });
  it('fly set NAME=VAL → fly secrets set NAME=VAL --app NAME', () => {
    expect(buildSecret(flyConfig, 'set', 'OPENAI_API_KEY=sk-xxx')).toEqual({
      binary: 'fly',
      args: ['secrets', 'set', 'OPENAI_API_KEY=sk-xxx', '--app', 'my-agent'],
    });
  });
  it('fly set without = throws', () => {
    expect(() => buildSecret(flyConfig, 'set', 'OPENAI_API_KEY')).toThrow(/NAME=VALUE/);
  });
  it('fly rm', () => {
    expect(buildSecret(flyConfig, 'rm', 'X')).toEqual({
      binary: 'fly',
      args: ['secrets', 'unset', 'X', '--app', 'my-agent'],
    });
  });
});

describe('buildDomain', () => {
  it('workers add', () => {
    expect(buildDomain(workersConfig, 'add', 'api.example.com')).toEqual({
      binary: 'wrangler',
      args: ['domains', 'add', 'api.example.com'],
    });
  });
  it('fly add', () => {
    expect(buildDomain(flyConfig, 'add', 'api.example.com')).toEqual({
      binary: 'fly',
      args: ['certs', 'add', 'api.example.com', '--app', 'my-agent'],
    });
  });
  it('fly rm', () => {
    expect(buildDomain(flyConfig, 'rm', 'api.example.com')).toEqual({
      binary: 'fly',
      args: ['certs', 'remove', 'api.example.com', '--app', 'my-agent'],
    });
  });
  it('empty hostname throws', () => {
    expect(() => buildDomain(flyConfig, 'add', '')).toThrow(/HOSTNAME/);
  });
});

describe('buildDev', () => {
  it('wraps cloudflared with the local URL', () => {
    expect(buildDev(3000)).toEqual({
      binary: 'cloudflared',
      args: ['tunnel', '--url', 'http://localhost:3000'],
    });
  });
});
