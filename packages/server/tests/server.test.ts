import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type {
  DeviceFlowStart,
  DevicePollResult,
  GitHubAuth,
  GitHubProfile,
} from '../src/auth/github.js';
import { type DbHandle, makeDbHandle, openDb } from '../src/db.js';
import { buildApp } from '../src/server.js';

class FakeGitHubAuth implements GitHubAuth {
  webAuthorizeUrl(state: string, redirectUri: string): string {
    return `https://github.example/oauth?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  }
  async exchangeCode(_code: string, _redirectUri: string): Promise<string> {
    return 'fake-access-token';
  }
  async fetchProfile(_token: string): Promise<GitHubProfile> {
    return { id: 7, login: 'edekiokoh', avatar_url: 'https://example.com/a.png' };
  }
  async startDeviceFlow(): Promise<DeviceFlowStart> {
    return {
      device_code: 'fake-dc',
      user_code: 'AAAA-BBBB',
      verification_uri: 'http://localhost:8787/auth/device/approve',
      expires_in: 600,
      interval: 5,
    };
  }
  async pollDevice(_deviceCode: string): Promise<DevicePollResult> {
    return { error: 'authorization_pending' };
  }
}

function fixture(): { app: ReturnType<typeof buildApp>['app']; handle: DbHandle } {
  const handle = makeDbHandle(openDb(':memory:'));
  const { app } = buildApp({
    db: handle,
    auth: new FakeGitHubAuth(),
    publicBaseUrl: 'http://test',
  });
  return { app, handle };
}

describe('healthz', () => {
  it('returns ok', async () => {
    const { app } = fixture();
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe('web OAuth', () => {
  it('redirects /auth/github to the authorize URL with state cookie', async () => {
    const { app } = fixture();
    const res = await request(app).get('/auth/github');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('https://github.example/oauth');
    const stateCookie = res.headers['set-cookie'].find((c: string) =>
      c.startsWith('airlock_oauth_state='),
    );
    expect(stateCookie).toBeTruthy();
  });

  it('exchanges code, creates user, sets session, redirects to /projects', async () => {
    const { app, handle } = fixture();
    const start = await request(app).get('/auth/github');
    const stateCookie = (start.headers['set-cookie'] as string[]).find((c) =>
      c.startsWith('airlock_oauth_state='),
    );
    expect(stateCookie).toBeDefined();
    const state = stateCookie?.split('=')[1].split(';')[0];

    const res = await request(app)
      .get(`/auth/github/callback?code=abc&state=${state}`)
      .set('Cookie', `airlock_oauth_state=${state}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/projects');
    const sessionCookie = (res.headers['set-cookie'] as string[]).find((c) =>
      c.startsWith('airlock_sid='),
    );
    expect(sessionCookie).toBeTruthy();

    // The user was persisted
    expect(handle.db.prepare('SELECT count(*) as n FROM users').get()).toEqual({ n: 1 });
  });

  it('rejects callback with bad state', async () => {
    const { app } = fixture();
    const res = await request(app)
      .get('/auth/github/callback?code=abc&state=wrong')
      .set('Cookie', 'airlock_oauth_state=correct');
    expect(res.status).toBe(400);
  });
});

describe('device flow', () => {
  it('creates a device code and exposes verification URI', async () => {
    const { app } = fixture();
    const res = await request(app).post('/auth/device');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      device_code: expect.any(String),
      user_code: expect.stringMatching(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
      verification_uri: 'http://test/auth/device/approve',
      expires_in: 600,
      interval: 5,
    });
  });

  it('poll returns pending until approved', async () => {
    const { app, handle } = fixture();
    const start = await request(app).post('/auth/device');
    const { device_code, user_code } = start.body as { device_code: string; user_code: string };

    const pending = await request(app).get(`/auth/device/poll?device_code=${device_code}`);
    expect(pending.body).toEqual({ status: 'pending' });

    // Simulate the user logging in via web and approving the code
    const user = handle.upsertUser({ id: 42, login: 'tester' });
    expect(handle.approveDeviceCode(user_code, user.id)).toBe(true);

    const approved = await request(app).get(`/auth/device/poll?device_code=${device_code}`);
    expect(approved.body.status).toBe('approved');
    expect(approved.body.access_token).toMatch(/^[a-f0-9]{64}$/);

    // Token resolves to the user via /api/whoami
    const whoami = await request(app)
      .get('/api/whoami')
      .set('Authorization', `Bearer ${approved.body.access_token}`);
    expect(whoami.status).toBe(200);
    expect(whoami.body.github_login).toBe('tester');
  });

  it('poll without device_code returns 400', async () => {
    const { app } = fixture();
    const res = await request(app).get('/auth/device/poll');
    expect(res.status).toBe(400);
  });
});

describe('api', () => {
  it('/api/whoami returns 401 without bearer', async () => {
    const { app } = fixture();
    const res = await request(app).get('/api/whoami');
    expect(res.status).toBe(401);
  });

  it('/api/projects round-trips a create+list with bearer', async () => {
    const { app, handle } = fixture();
    const user = handle.upsertUser({ id: 7, login: 'edekiokoh' });
    const token = mintCliToken(handle, user.id);

    const create = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'my-agent', target: 'fly' });
    expect(create.status).toBe(201);
    expect(create.body).toMatchObject({ name: 'my-agent', target: 'fly' });

    const list = await request(app).get('/api/projects').set('Authorization', `Bearer ${token}`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].name).toBe('my-agent');
  });

  it('/api/inspect records a call when the project exists', async () => {
    const { app, handle } = fixture();
    const user = handle.upsertUser({ id: 7, login: 'x' });
    const token = mintCliToken(handle, user.id);
    handle.upsertProject(user.id, 'my-agent', 'fly');

    const res = await request(app)
      .post('/api/inspect')
      .set('Authorization', `Bearer ${token}`)
      .send({
        project_name: 'my-agent',
        caller: '0xabc',
        status: 200,
        request_url: 'http://agent.test/chat',
        tokens_used: 1234,
        payment_settled: true,
      });
    expect(res.status).toBe(200);

    const projects = handle.listProjects(user.id);
    const calls = handle.listInspectCalls(projects[0].id);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      caller: '0xabc',
      status: 200,
      tokens_used: 1234,
      payment_settled: 1,
    });
  });

  it('/api/projects/:id/stats aggregates calls + revenue + tokens + unique callers', async () => {
    const { app, handle } = fixture();
    const user = handle.upsertUser({ id: 7, login: 'x' });
    const token = mintCliToken(handle, user.id);
    const project = handle.upsertProject(user.id, 'my-agent', 'fly');

    // Two paid (different callers), one unpaid 402.
    handle.recordInspectCall(project.id, {
      timestamp: Date.now(),
      caller: '0xa',
      status: 200,
      request_url: 'http://x',
      request_body: null,
      response_body: null,
      tokens_used: 100,
      amount_usdc: '0.10',
      payment_settled: 1,
    });
    handle.recordInspectCall(project.id, {
      timestamp: Date.now(),
      caller: '0xb',
      status: 200,
      request_url: 'http://x',
      request_body: null,
      response_body: null,
      tokens_used: 200,
      amount_usdc: '0.25',
      payment_settled: 1,
    });
    handle.recordInspectCall(project.id, {
      timestamp: Date.now(),
      caller: null,
      status: 402,
      request_url: 'http://x',
      request_body: null,
      response_body: null,
      tokens_used: null,
      amount_usdc: null,
      payment_settled: 0,
    });

    const res = await request(app)
      .get(`/api/projects/${project.id}/stats`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total_calls: 3,
      paid_calls: 2,
      total_revenue_usdc: '0.35',
      unique_callers: 2, // COUNT(DISTINCT caller) skips NULLs
      total_tokens: 300,
    });
  });

  it('/api/projects/:id/stats returns 404 for unknown project', async () => {
    const { app, handle } = fixture();
    const user = handle.upsertUser({ id: 8, login: 'x' });
    const token = mintCliToken(handle, user.id);
    const res = await request(app)
      .get('/api/projects/9999/stats')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('/api/inspect returns 404 for unknown project', async () => {
    const { app, handle } = fixture();
    const user = handle.upsertUser({ id: 9, login: 'x' });
    const token = mintCliToken(handle, user.id);
    const res = await request(app)
      .post('/api/inspect')
      .set('Authorization', `Bearer ${token}`)
      .send({
        project_name: 'never-registered',
        status: 200,
        request_url: 'http://x',
      });
    expect(res.status).toBe(404);
  });
});

describe('CSRF', () => {
  async function loggedInClient() {
    const { app, handle } = fixture();
    const user = handle.upsertUser({ id: 42, login: 'tester' });
    const sid = handle.createSession(user.id, 3600);
    return { app, handle, user, sid };
  }

  it('rejects POST /auth/device/approve without a CSRF token', async () => {
    const { app, sid } = await loggedInClient();
    const res = await request(app)
      .post('/auth/device/approve')
      .set('Cookie', `airlock_sid=${sid}`)
      .type('form')
      .send({ user_code: 'AAAA-BBBB' });
    expect(res.status).toBe(403);
  });

  it('rejects POST /auth/device/approve with a mismatched CSRF token', async () => {
    const { app, sid } = await loggedInClient();
    const res = await request(app)
      .post('/auth/device/approve')
      .set('Cookie', `airlock_sid=${sid}; airlock_csrf=real-token`)
      .type('form')
      .send({ user_code: 'AAAA-BBBB', _csrf: 'wrong-token' });
    expect(res.status).toBe(403);
  });

  it('accepts POST /auth/device/approve with matching CSRF token from a GET', async () => {
    const { app, sid, handle } = await loggedInClient();
    // Pre-create a pending device code we can approve
    const code = handle.createDeviceCode(600);

    // GET the form to receive the CSRF cookie
    const formRes = await request(app)
      .get('/auth/device/approve')
      .set('Cookie', `airlock_sid=${sid}`);
    const csrfCookie = (formRes.headers['set-cookie'] as string[]).find((c) =>
      c.startsWith('airlock_csrf='),
    );
    expect(csrfCookie).toBeDefined();
    const csrf = csrfCookie?.split(';')[0].split('=')[1];

    const res = await request(app)
      .post('/auth/device/approve')
      .set('Cookie', `airlock_sid=${sid}; airlock_csrf=${csrf}`)
      .type('form')
      .send({ user_code: code.user_code, _csrf: csrf });

    expect(res.status).toBe(200);
    expect(res.text).toContain('Authorized CLI device');
  });

  it('rejects POST /auth/logout without CSRF', async () => {
    const { app, sid } = await loggedInClient();
    const res = await request(app).post('/auth/logout').set('Cookie', `airlock_sid=${sid}`);
    expect(res.status).toBe(403);
  });

  it('accepts POST /auth/logout with valid CSRF and clears the session', async () => {
    const { app, sid } = await loggedInClient();
    // /projects issues the CSRF cookie for us
    const page = await request(app).get('/projects').set('Cookie', `airlock_sid=${sid}`);
    const csrfCookie = (page.headers['set-cookie'] as string[]).find((c) =>
      c.startsWith('airlock_csrf='),
    );
    const csrf = csrfCookie?.split(';')[0].split('=')[1];

    const res = await request(app)
      .post('/auth/logout')
      .set('Cookie', `airlock_sid=${sid}; airlock_csrf=${csrf}`)
      .type('form')
      .send({ _csrf: csrf });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
    // The Set-Cookie should clear airlock_sid
    const clearCookie = (res.headers['set-cookie'] as string[]).find((c) =>
      c.startsWith('airlock_sid='),
    );
    expect(clearCookie).toMatch(/Expires=/);
  });
});

describe('dashboard pages', () => {
  it('/ renders the login page when unauthenticated', async () => {
    const { app } = fixture();
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Sign in');
    expect(res.text).toContain('Continue with GitHub');
  });

  it('/projects redirects to / when unauthenticated', async () => {
    const { app } = fixture();
    const res = await request(app).get('/projects');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });
});

function mintCliToken(handle: DbHandle, userId: number): string {
  const token = 'test-cli-token';
  handle.db
    .prepare('INSERT INTO cli_tokens (token, user_id, created_at) VALUES (?, ?, ?)')
    .run(token, userId, Date.now());
  return token;
}
