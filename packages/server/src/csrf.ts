/**
 * Double-submit-cookie CSRF protection for dashboard forms.
 *
 * Flow:
 *   1. When rendering a form: issueToken() → returns a random hex token AND
 *      sets it as an httpOnly, sameSite=lax cookie on the response.
 *   2. Form includes <input name="_csrf" value="<token>"> hidden field.
 *   3. POST handler calls verifyToken(req): true iff req.cookies.airlock_csrf
 *      equals req.body._csrf.
 *
 * Why this works:
 *   - The attacker can fire a cross-site POST that includes the user's
 *     airlock_csrf cookie (sameSite=lax allows it on top-level nav), but they
 *     cannot read its value (httpOnly), so they can't fabricate a matching
 *     `_csrf` form field.
 *   - Bearer-authed JSON endpoints don't need this because browsers don't
 *     auto-send bearer tokens.
 */

import type { Request, Response } from 'express';

export const CSRF_COOKIE = 'airlock_csrf';
export const CSRF_FIELD = '_csrf';

export function issueToken(res: Response): string {
  const token = randHex(16);
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 1000, // 1 hour
  });
  return token;
}

export function verifyToken(req: Request): boolean {
  const cookieToken = (req.cookies as { [k: string]: string })?.[CSRF_COOKIE];
  const bodyToken = (req.body as { [k: string]: string })?.[CSRF_FIELD];
  if (!cookieToken || !bodyToken) return false;
  return constantTimeEqual(cookieToken, bodyToken);
}

function randHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
