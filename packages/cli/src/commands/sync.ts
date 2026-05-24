import { readAuth } from '../auth-store.js';
import { readConfig } from '../config-file.js';
import { NotLoggedInError } from './whoami.js';

export interface SyncedProject {
  id: number;
  name: string;
  target: string;
}

export interface SyncOptions {
  cwd: string;
  fetchImpl?: typeof fetch;
  /** Override the stored auth (tests). */
  auth?: { backend: string; token: string };
}

/**
 * Register the local project with the airlock-deploy backend so the dashboard
 * can record its inspect calls. Reads `.airlock-deploy/config.toml` + the
 * stored auth token, POSTs `/api/projects` (idempotent upsert), and returns
 * the saved project record. Publishers run this after `init` + `login`.
 */
export async function runSync(opts: SyncOptions): Promise<SyncedProject> {
  const auth = opts.auth ?? (await readAuth());
  if (!auth) throw new NotLoggedInError();

  const config = await readConfig(opts.cwd);
  if (!config.project?.name || !config.project?.target) {
    throw new Error('invalid .airlock-deploy/config.toml — project.name and target required');
  }

  const fetchFn = opts.fetchImpl ?? fetch;
  const res = await fetchFn(`${auth.backend.replace(/\/$/, '')}/api/projects`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${auth.token}`,
    },
    body: JSON.stringify({ name: config.project.name, target: config.project.target }),
  });
  if (res.status === 401) throw new NotLoggedInError();
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`sync failed: ${res.status} ${body}`);
  }
  return (await res.json()) as SyncedProject;
}
