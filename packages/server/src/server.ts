/**
 * airlock-deploy backend server.
 *
 * Env:
 *   PORT                 default 8787
 *   DB_PATH              default ./airlock.db
 *   GITHUB_CLIENT_ID     required for OAuth (create at https://github.com/settings/developers)
 *   GITHUB_CLIENT_SECRET required for OAuth
 *   PUBLIC_BASE_URL      default http://localhost:8787
 */

import cookieParser from 'cookie-parser';
import express, { type Express, type Request } from 'express';
import { z } from 'zod';
import { type GitHubAuth, RealGitHubAuth } from './auth/github.js';
import { issueToken, verifyToken } from './csrf.js';
import { type DbHandle, makeDbHandle, openDb, type User } from './db.js';
import { deviceApprovePage, loginPage, projectDetailPage, projectsPage } from './pages.js';

const SESSION_COOKIE = 'airlock_sid';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const DEVICE_TTL_SECONDS = 60 * 10; // 10 minutes

export interface ServerOptions {
  port?: number;
  dbPath?: string;
  publicBaseUrl?: string;
  auth?: GitHubAuth;
  db?: DbHandle;
}

export interface BuildAppResult {
  app: Express;
  handle: DbHandle;
  dbPath: string;
  publicBaseUrl: string;
}

export function buildApp(options: ServerOptions = {}): BuildAppResult {
  const dbPath = options.dbPath ?? process.env.DB_PATH ?? './airlock.db';
  const publicBaseUrl =
    options.publicBaseUrl ?? process.env.PUBLIC_BASE_URL ?? 'http://localhost:8787';
  const clientId = process.env.GITHUB_CLIENT_ID ?? '';
  const clientSecret = process.env.GITHUB_CLIENT_SECRET ?? '';
  const auth: GitHubAuth = options.auth ?? new RealGitHubAuth(clientId, clientSecret);
  const handle: DbHandle = options.db ?? makeDbHandle(openDb(dbPath));

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  // ──────────────────────────────── Web OAuth ────────────────────────────────

  app.get('/auth/github', (_req, res) => {
    const state = randHex(8);
    res.cookie('airlock_oauth_state', state, { httpOnly: true, sameSite: 'lax' });
    const redirectUri = `${publicBaseUrl}/auth/github/callback`;
    res.redirect(auth.webAuthorizeUrl(state, redirectUri));
  });

  app.get('/auth/github/callback', async (req, res) => {
    try {
      const { code, state } = req.query as { code?: string; state?: string };
      if (!code || !state || state !== req.cookies.airlock_oauth_state) {
        res.status(400).send('invalid oauth state');
        return;
      }
      res.clearCookie('airlock_oauth_state');
      const redirectUri = `${publicBaseUrl}/auth/github/callback`;
      const token = await auth.exchangeCode(code, redirectUri);
      const profile = await auth.fetchProfile(token);
      const user = handle.upsertUser(profile);
      const sid = handle.createSession(user.id, SESSION_TTL_SECONDS);
      res.cookie(SESSION_COOKIE, sid, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: SESSION_TTL_SECONDS * 1000,
      });
      res.redirect('/projects');
    } catch (err) {
      res.status(500).send(`oauth callback failed: ${(err as Error).message}`);
    }
  });

  app.post('/auth/logout', (req, res) => {
    if (!verifyToken(req)) {
      res.status(403).send('CSRF token invalid');
      return;
    }
    const sid = req.cookies[SESSION_COOKIE];
    if (sid) handle.deleteSession(sid);
    res.clearCookie(SESSION_COOKIE);
    res.redirect('/');
  });

  // ──────────────────────────────── Device flow ────────────────────────────────

  app.post('/auth/device', (_req, res) => {
    const code = handle.createDeviceCode(DEVICE_TTL_SECONDS);
    res.json({
      device_code: code.device_code,
      user_code: code.user_code,
      verification_uri: `${publicBaseUrl}/auth/device/approve`,
      expires_in: DEVICE_TTL_SECONDS,
      interval: 5,
    });
  });

  app.get('/auth/device/approve', (req, res) => {
    const user = currentUser(req, handle);
    if (!user) {
      res.redirect(`/auth/github?next=/auth/device/approve`);
      return;
    }
    const csrf = issueToken(res);
    res.type('html').send(deviceApprovePage(user, csrf));
  });

  app.post('/auth/device/approve', (req, res) => {
    const user = currentUser(req, handle);
    if (!user) {
      res.redirect('/auth/github?next=/auth/device/approve');
      return;
    }
    if (!verifyToken(req)) {
      res.status(403).send('CSRF token invalid');
      return;
    }
    const userCode = String(req.body.user_code ?? '')
      .trim()
      .toUpperCase();
    const csrf = issueToken(res);
    if (!userCode) {
      res
        .status(400)
        .type('html')
        .send(deviceApprovePage(user, csrf, 'no code provided'));
      return;
    }
    const ok = handle.approveDeviceCode(userCode, user.id);
    res
      .type('html')
      .send(
        ok
          ? deviceApprovePage(
              user,
              csrf,
              undefined,
              `Authorized CLI device for ${user.github_login}`,
            )
          : deviceApprovePage(user, csrf, `code ${userCode} not found or already used`),
      );
  });

  app.get('/auth/device/poll', (req, res) => {
    const deviceCode = String(req.query.device_code ?? '');
    if (!deviceCode) {
      res.status(400).json({ error: 'device_code required' });
      return;
    }
    const result = handle.pollDeviceCode(deviceCode);
    if (result.status === 'approved' && result.cliToken) {
      res.json({ status: 'approved', access_token: result.cliToken });
      return;
    }
    res.json({ status: result.status });
  });

  // ──────────────────────────────── API ────────────────────────────────

  app.get('/api/whoami', (req, res) => {
    const user = bearerUser(req, handle);
    if (!user) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    res.json({
      id: user.id,
      github_id: user.github_id,
      github_login: user.github_login,
      avatar_url: user.avatar_url,
    });
  });

  const RegisterProjectSchema = z.object({
    name: z.string().min(1).max(64),
    target: z.enum(['workers', 'fly']),
  });

  app.post('/api/projects', (req, res) => {
    const user = bearerUser(req, handle);
    if (!user) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    const parsed = RegisterProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const project = handle.upsertProject(user.id, parsed.data.name, parsed.data.target);
    res.status(201).json(project);
  });

  app.get('/api/projects', (req, res) => {
    const user = bearerUser(req, handle);
    if (!user) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    res.json(handle.listProjects(user.id));
  });

  const InspectCallSchema = z.object({
    project_name: z.string(),
    caller: z.string().nullable().optional(),
    status: z.number().int(),
    request_url: z.string(),
    request_body: z.string().nullable().optional(),
    response_body: z.string().nullable().optional(),
    tokens_used: z.number().int().nullable().optional(),
    amount_usdc: z.string().nullable().optional(),
    payment_settled: z.boolean().optional(),
  });

  app.post('/api/inspect', (req, res) => {
    const user = bearerUser(req, handle);
    if (!user) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    const parsed = InspectCallSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const project = handle.listProjects(user.id).find((p) => p.name === parsed.data.project_name);
    if (!project) {
      res.status(404).json({ error: 'project not found; POST /api/projects first' });
      return;
    }
    handle.recordInspectCall(project.id, {
      timestamp: Date.now(),
      caller: parsed.data.caller ?? null,
      status: parsed.data.status,
      request_url: parsed.data.request_url,
      request_body: parsed.data.request_body ?? null,
      response_body: parsed.data.response_body ?? null,
      tokens_used: parsed.data.tokens_used ?? null,
      amount_usdc: parsed.data.amount_usdc ?? null,
      payment_settled: parsed.data.payment_settled ? 1 : 0,
    });
    res.json({ ok: true });
  });

  app.get('/api/projects/:id/stats', (req, res) => {
    const user = bearerUser(req, handle);
    if (!user) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    const id = Number.parseInt(req.params.id, 10);
    const project = handle.getProject(user.id, id);
    if (!project) {
      res.status(404).json({ error: 'project not found' });
      return;
    }
    res.json(handle.getProjectStats(project.id));
  });

  // ──────────────────────────────── Dashboard pages ────────────────────────────────

  app.get('/', (req, res) => {
    const user = currentUser(req, handle);
    if (user) {
      res.redirect('/projects');
      return;
    }
    res.type('html').send(loginPage());
  });

  app.get('/projects', (req, res) => {
    const user = currentUser(req, handle);
    if (!user) {
      res.redirect('/');
      return;
    }
    const csrf = issueToken(res);
    res.type('html').send(projectsPage(user, csrf, handle.listProjects(user.id)));
  });

  app.get('/projects/:id', (req, res) => {
    const user = currentUser(req, handle);
    if (!user) {
      res.redirect('/');
      return;
    }
    const csrf = issueToken(res);
    const id = Number.parseInt(req.params.id, 10);
    const project = handle.getProject(user.id, id);
    if (!project) {
      res.status(404).send('project not found');
      return;
    }
    res
      .type('html')
      .send(
        projectDetailPage(
          user,
          csrf,
          project,
          handle.getProjectStats(project.id),
          handle.listInspectCalls(project.id),
        ),
      );
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  return { app, handle, dbPath, publicBaseUrl };
}

function currentUser(req: Request, handle: DbHandle): User | null {
  const sid = (req.cookies as { [k: string]: string })?.[SESSION_COOKIE];
  if (!sid) return null;
  return handle.getUserBySession(sid);
}

function bearerUser(req: Request, handle: DbHandle): User | null {
  const header = req.headers.authorization;
  if (!header || !header.toLowerCase().startsWith('bearer ')) return null;
  return handle.getUserByCliToken(header.slice(7).trim());
}

function randHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

// CLI entry: started directly (not imported)
const url = import.meta.url;
const arg1 = process.argv[1];
if (arg1 && (url === `file://${arg1}` || url.endsWith(`/${arg1.split('/').pop()}`))) {
  const port = Number.parseInt(process.env.PORT ?? '8787', 10);
  const { app, dbPath, publicBaseUrl } = buildApp();
  app.listen(port, () => {
    console.log(`airlock-deploy server listening on http://localhost:${port}`);
    console.log(`  db:           ${dbPath}`);
    console.log(`  public URL:   ${publicBaseUrl}`);
    console.log(
      `  github OAuth: ${process.env.GITHUB_CLIENT_ID ? 'configured' : 'NOT CONFIGURED — set GITHUB_CLIENT_ID/SECRET'}`,
    );
  });
}
