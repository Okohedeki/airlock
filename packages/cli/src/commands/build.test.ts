import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { computeTag, generateDockerfile, resolveBuildPlan, slug } from './build.js';

describe('airlock build (pure)', () => {
  it('slugifies worker names into docker-safe segments', () => {
    expect(slug('My Worker!')).toBe('my-worker');
    expect(slug('')).toBe('worker');
  });

  it('content tag is stable for the same inputs and changes when they change', () => {
    const a = computeTag(['worker.yaml-bytes', 'reqs', 'base']);
    const b = computeTag(['worker.yaml-bytes', 'reqs', 'base']);
    const c = computeTag(['worker.yaml-bytes-CHANGED', 'reqs', 'base']);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(12);
  });

  it('generates a Dockerfile that installs requirements only when present', () => {
    expect(generateDockerfile('airlockhq/airlock:dev', true)).toContain('pip install');
    expect(generateDockerfile('airlockhq/airlock:dev', false)).not.toContain('pip install');
    expect(generateDockerfile('base:x', true)).toContain('FROM base:x');
    expect(generateDockerfile('base:x', true)).toContain('WORKDIR /app/worker');
  });

  it('resolveBuildPlan validates worker.yaml and produces a content-addressed image', () => {
    const dir = mkdtempSync(join(tmpdir(), 'airlock-build-'));
    writeFileSync(join(dir, 'worker.yaml'), 'worker:\n  name: demo\nharness: stub\n');
    const plan = resolveBuildPlan({ cwd: dir });
    expect(plan.image).toMatch(/^airlock\/demo:[0-9a-f]{12}$/);
    expect(plan.hasRequirements).toBe(false);
    // same manifest → same tag
    expect(resolveBuildPlan({ cwd: dir }).tag).toBe(plan.tag);
  });

  it('resolveBuildPlan rejects an invalid worker.yaml (C2 gate)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'airlock-build-'));
    writeFileSync(join(dir, 'worker.yaml'), 'harness: not-a-real-harness\n'); // missing worker.name
    expect(() => resolveBuildPlan({ cwd: dir })).toThrow(/invalid/i);
  });
});
