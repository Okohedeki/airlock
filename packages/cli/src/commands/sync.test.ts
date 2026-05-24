import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeConfig } from '../config-file.js';
import { runSync } from './sync.js';
import { NotLoggedInError } from './whoami.js';

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'airlock-cli-sync-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('runSync', () => {
  it('POSTs the project to /api/projects with the bearer token and returns the response', async () => {
    await writeConfig(cwd, { project: { name: 'my-agent', target: 'fly', schemaVersion: 1 } });

    const seen: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), init });
      return new Response(JSON.stringify({ id: 99, name: 'my-agent', target: 'fly' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const result = await runSync({
      cwd,
      auth: { backend: 'http://backend.test', token: 'tok' },
      fetchImpl,
    });

    expect(result).toEqual({ id: 99, name: 'my-agent', target: 'fly' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('http://backend.test/api/projects');
    expect((seen[0]?.init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ name: 'my-agent', target: 'fly' });
  });

  it('throws NotLoggedInError on a 401 from the backend', async () => {
    await writeConfig(cwd, { project: { name: 'x', target: 'fly', schemaVersion: 1 } });
    const fetchImpl = (async () => new Response('', { status: 401 })) as typeof fetch;
    await expect(
      runSync({ cwd, auth: { backend: 'http://test', token: 'bad' }, fetchImpl }),
    ).rejects.toBeInstanceOf(NotLoggedInError);
  });

  it('errors when no config file exists', async () => {
    await expect(runSync({ cwd, auth: { backend: 'http://test', token: 'tok' } })).rejects.toThrow(
      /ENOENT|config\.toml/,
    );
  });
});
