import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export interface ManagedAccess { operator: string; caller: string }

/** Per-project access lives in the user's private Airlock home, outside the repository. */
export async function managedAccess(cwd: string): Promise<ManagedAccess> {
  const home = join(homedir(), '.airlock', 'access');
  await mkdir(home, { recursive: true, mode: 0o700 });
  const id = createHash('sha256').update(resolve(cwd)).digest('hex');
  const path = join(home, `${id}.json`);
  const generated = { operator: randomBytes(32).toString('hex'), caller: randomBytes(32).toString('hex') };
  try {
    await writeFile(path, JSON.stringify(generated), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const saved = JSON.parse(await readFile(path, 'utf8')) as ManagedAccess;
  if (!/^[a-f0-9]{64}$/.test(saved.operator) || !/^[a-f0-9]{64}$/.test(saved.caller)) {
    throw new Error('Saved Airlock access is invalid. Restore your access file before starting.');
  }
  return saved;
}
