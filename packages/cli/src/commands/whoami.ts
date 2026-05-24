import { readAuth } from '../auth-store.js';

export interface WhoamiResult {
  id: number;
  github_id: number;
  github_login: string;
  avatar_url: string | null;
}

export class NotLoggedInError extends Error {
  constructor() {
    super('not logged in — run `airlock-deploy login`');
    this.name = 'NotLoggedInError';
  }
}

export interface WhoamiOptions {
  fetchImpl?: typeof fetch;
  /** Override the stored auth (tests). */
  auth?: { backend: string; token: string };
}

export async function runWhoami(opts: WhoamiOptions = {}): Promise<WhoamiResult> {
  const auth = opts.auth ?? (await readAuth());
  if (!auth) throw new NotLoggedInError();
  const fetchFn = opts.fetchImpl ?? fetch;

  const res = await fetchFn(`${auth.backend}/api/whoami`, {
    headers: { authorization: `Bearer ${auth.token}` },
  });
  if (res.status === 401) {
    throw new NotLoggedInError();
  }
  if (!res.ok) {
    throw new Error(`whoami failed: ${res.status}`);
  }
  return (await res.json()) as WhoamiResult;
}
