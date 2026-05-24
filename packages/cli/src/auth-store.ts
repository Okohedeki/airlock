import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

export interface StoredAuth {
  backend: string;
  token: string;
  saved_at: number;
}

export function authPath(): string {
  return resolve(homedir(), '.airlock-deploy', 'auth.json');
}

export async function readAuth(): Promise<StoredAuth | null> {
  try {
    const raw = await readFile(authPath(), 'utf8');
    return JSON.parse(raw) as StoredAuth;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeAuth(auth: StoredAuth): Promise<void> {
  const path = authPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(auth, null, 2), 'utf8');
  await chmod(path, 0o600);
}

export async function clearAuth(): Promise<void> {
  try {
    await rm(authPath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
