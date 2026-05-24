import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAuth, readAuth } from '../auth-store.js';
import { runLogin } from './login.js';
import { NotLoggedInError, runWhoami } from './whoami.js';

let oldHome: string | undefined;

beforeEach(async () => {
  // Redirect HOME to a temp dir so we don't touch the user's real ~/.airlock-deploy
  oldHome = process.env.HOME;
  process.env.HOME = await mkdtemp(join(tmpdir(), 'airlock-cli-auth-'));
});

afterEach(async () => {
  if (process.env.HOME) await rm(process.env.HOME, { recursive: true, force: true });
  process.env.HOME = oldHome;
});

function fakeFetchSequence(responses: Array<{ status?: number; body: unknown }>): typeof fetch {
  let idx = 0;
  return (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const r = responses[idx++];
    if (!r) throw new Error(`unexpected fetch beyond responses: ${String(input)}`);
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('runLogin', () => {
  it('polls until approved, then persists the token', async () => {
    const fetchImpl = fakeFetchSequence([
      {
        body: {
          device_code: 'dc-1',
          user_code: 'AAAA-BBBB',
          verification_uri: 'http://test/auth/device/approve',
          expires_in: 60,
          interval: 0,
        },
      },
      { body: { status: 'pending' } },
      { body: { status: 'approved', access_token: 'real-token' } },
    ]);

    const result = await runLogin({
      backend: 'http://test',
      io: { fetchImpl, sleep: async () => {}, onStart: () => {}, maxPolls: 5 },
    });

    expect(result.token).toBe('real-token');
    const stored = await readAuth();
    expect(stored?.token).toBe('real-token');
    expect(stored?.backend).toBe('http://test');

    // Permissions: 0600 on the auth file
    const path = `${process.env.HOME}/.airlock-deploy/auth.json`;
    const raw = await readFile(path, 'utf8');
    expect(JSON.parse(raw).token).toBe('real-token');
  });

  it('throws when the device code expires before approval', async () => {
    const fetchImpl = fakeFetchSequence([
      {
        body: {
          device_code: 'dc-2',
          user_code: 'XXXX-YYYY',
          verification_uri: 'http://test/v',
          expires_in: 60,
          interval: 0,
        },
      },
      { body: { status: 'expired' } },
    ]);

    await expect(
      runLogin({
        backend: 'http://test',
        io: { fetchImpl, sleep: async () => {}, onStart: () => {}, maxPolls: 5 },
      }),
    ).rejects.toThrow(/expired/);
  });

  it('throws when the start endpoint errors', async () => {
    const fetchImpl = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    await expect(
      runLogin({ backend: 'http://test', io: { fetchImpl, onStart: () => {} } }),
    ).rejects.toThrow(/device flow start failed: 500/);
  });
});

describe('runWhoami', () => {
  it('throws NotLoggedInError when no auth is stored', async () => {
    await clearAuth();
    await expect(runWhoami()).rejects.toBeInstanceOf(NotLoggedInError);
  });

  it('returns the user when the backend confirms the token', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ id: 1, github_id: 7, github_login: 'me', avatar_url: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const result = await runWhoami({
      auth: { backend: 'http://test', token: 'tok' },
      fetchImpl,
    });
    expect(result.github_login).toBe('me');
  });

  it('throws NotLoggedInError on 401', async () => {
    const fetchImpl = (async () => new Response('', { status: 401 })) as typeof fetch;
    await expect(
      runWhoami({ auth: { backend: 'http://test', token: 'bad' }, fetchImpl }),
    ).rejects.toBeInstanceOf(NotLoggedInError);
  });
});
