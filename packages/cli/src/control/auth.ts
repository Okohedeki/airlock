/**
 * Real RBAC + session auth for the airlock Control Plane.
 *
 * Roles map to permissions; every mutating endpoint checks `can(role, perm)` and 403s on deny —
 * enforcement is real, not cosmetic. Sessions are cookie-based (in-memory tokens; re-login after
 * restart). Local login authenticates a user from the durable store; when SSO is `enforced`,
 * local login is blocked and the OIDC path is required (an external IdP must be configured —
 * `oidcIssuer`/`oidcClientId` — to complete that flow).
 */

import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ControlStore } from './store.js';

export const COOKIE = 'airlock_sid';

/** Role → permission grants. Supports `*`, `area:*`, and `*:read` wildcards. */
export const ROLE_PERMS: Record<string, string[]> = {
  owner: ['*'],
  operator: ['*:read', 'workers:start', 'workers:stop', 'workers:config', 'control:write', 'exposure:write', 'versions:write', 'approvals:decide', 'env:write'],
  approver: ['*:read', 'approvals:decide'],
  auditor: ['*:read', 'audit:read'],
  viewer: ['overview:read', 'workers:read', 'runs:read'],
};

export function can(role: string, perm: string): boolean {
  const perms = ROLE_PERMS[role] || [];
  for (const p of perms) {
    if (p === '*' || p === perm) return true;
    if (p.endsWith(':*') && perm.startsWith(p.slice(0, -1))) return true;
    if (p === '*:read' && perm.endsWith(':read')) return true;
  }
  return false;
}

interface Session { email: string; since: number; }
const sessions = new Map<string, Session>();

export interface SessionUser { name: string; email: string; role: string; }

function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function currentUser(store: ControlStore, req: IncomingMessage): SessionUser | null {
  const tok = parseCookies(req)[COOKIE];
  const s = tok && sessions.get(tok);
  if (!s) return null;
  const u = store.users().find((x) => x.email === s.email);
  return u ? { name: u.name, email: u.email, role: u.role } : null;
}

export interface LoginResult { ok: boolean; error?: string; user?: SessionUser; }

export function login(store: ControlStore, res: ServerResponse, email: string, password?: string): LoginResult {
  const u = store.users().find((x) => x.email === email);
  if (!u) return { ok: false, error: 'unknown user' };
  if (store.sso().enforced) return { ok: false, error: 'sso_enforced' };
  if (u.password && u.password !== password) return { ok: false, error: 'bad password' };
  const tok = randomBytes(18).toString('hex');
  sessions.set(tok, { email, since: Date.now() });
  res.setHeader('Set-Cookie', `${COOKIE}=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`);
  return { ok: true, user: { name: u.name, email: u.email, role: u.role } };
}

export function logout(req: IncomingMessage, res: ServerResponse): void {
  const tok = parseCookies(req)[COOKIE];
  if (tok) sessions.delete(tok);
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
}
