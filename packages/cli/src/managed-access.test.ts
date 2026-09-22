import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
const home = vi.hoisted(() => ({ value: '' }));
vi.mock('node:os', () => ({ homedir: () => home.value }));
import { managedAccess } from './managed-access.js';

describe('managed project credentials', () => {
  beforeAll(async () => { home.value = await mkdtemp(join(process.env.TEMP ?? '.', 'airlock-access-test-')); });
  afterAll(async () => {
    const target = resolve(home.value);
    if (!target.startsWith(resolve(process.env.TEMP ?? '.') + '\\') && process.platform === 'win32') {
      throw new Error('Test cleanup must stay inside the temporary directory');
    }
    await rm(target, { recursive: true, force: true });
  });
  it('persists separate credentials per project across launcher restarts', async () => {
    const first = await managedAccess(join(home.value, 'project-one'));
    expect(first.operator).toMatch(/^[a-f0-9]{64}$/);
    expect(first.caller).toMatch(/^[a-f0-9]{64}$/);
    expect(first.operator).not.toBe(first.caller);
    expect(await managedAccess(join(home.value, 'project-one'))).toEqual(first);
    expect(await managedAccess(join(home.value, 'project-two'))).not.toEqual(first);
  });
  it('refuses corrupted access rather than silently changing a projects keys', async () => {
    const project = join(home.value, 'project-corrupt');
    const credentials = await managedAccess(project);
    const directory = join(home.value, '.airlock', 'access');
    for (const file of await readdir(directory)) {
      const path = join(directory, file);
      if (JSON.parse(await readFile(path, 'utf8')).operator === credentials.operator) {
        await writeFile(path, JSON.stringify({ operator: 'bad', caller: credentials.caller }));
      }
    }
    await expect(managedAccess(project)).rejects.toThrow('Saved Airlock access is invalid');
  });
});
