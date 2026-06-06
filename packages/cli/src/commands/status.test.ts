import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeConfig } from '../config-file.js';
import { runStatus } from './status.js';

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'airlock-cli-status-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('runStatus', () => {
  it('reports the project summary', async () => {
    await writeConfig(cwd, {
      project: { name: 'demo', target: 'workers', schemaVersion: 1 },
    });
    const summary = await runStatus(cwd);
    expect(summary.project).toEqual({ name: 'demo', target: 'workers' });
  });
});
