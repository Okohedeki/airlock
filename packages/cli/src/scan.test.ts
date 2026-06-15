import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanRepo } from './scan.js';

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'airlock-scan-'));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('scanRepo', () => {
  it('detects harness from a dependency and finds a factory entrypoint', async () => {
    await writeFile(join(cwd, 'requirements.txt'), 'langgraph>=0.2\nlangchain-openai\n');
    await writeFile(join(cwd, 'agents.py'), 'def build_agent():\n    return object()\n');
    const r = await scanRepo(cwd);
    expect(r.harness).toBe('langgraph');
    expect(r.entrypoint).toBe('agents:build_agent');
  });

  it('detects harness from an import when no dep manifest matches', async () => {
    await writeFile(join(cwd, 'main.py'), 'from smolagents import CodeAgent\nagent = CodeAgent()\n');
    const r = await scanRepo(cwd);
    expect(r.harness).toBe('smolagents');
    expect(r.entrypoint).toBe('main:agent');
  });

  it('resolves a src/package layout to an importable module', async () => {
    await mkdir(join(cwd, 'src', 'my_pkg'), { recursive: true });
    await writeFile(join(cwd, 'src', 'my_pkg', '__init__.py'), 'from crewai import Crew\ndef build_crew():\n    return None\n');
    const r = await scanRepo(cwd);
    expect(r.harness).toBe('crewai');
    expect(r.entrypoint).toBe('my_pkg:build_crew');
  });

  it('reports when nothing is found', async () => {
    await writeFile(join(cwd, 'readme.txt'), 'no python here');
    const r = await scanRepo(cwd);
    expect(r.harness).toBeUndefined();
    expect(r.entrypoint).toBeUndefined();
    expect(r.evidence.join(' ')).toMatch(/not detected|not found/);
  });

  it('declares tools the harness exposes (@tool / @function_tool)', async () => {
    await writeFile(join(cwd, 'requirements.txt'), 'claude-agent-sdk>=0.1\n');
    await writeFile(
      join(cwd, 'agent.py'),
      '@tool("multiply", "x", {})\nasync def multiply(a): ...\n@tool("danger", "y", {})\nasync def danger(a): ...\ndef build_options():\n    return []\n',
    );
    const r = await scanRepo(cwd);
    expect(r.tools).toEqual(['multiply', 'danger']);
    expect(r.evidence.join(' ')).toContain('tools: multiply, danger');
  });

  it('resolves entrypoint relative to the harness folder when --detect <dir> is given', async () => {
    await mkdir(join(cwd, 'src', 'agent'), { recursive: true });
    await writeFile(join(cwd, 'src', 'agent', 'requirements.txt'), 'claude-agent-sdk>=0.1\n');
    await writeFile(
      join(cwd, 'src', 'agent', 'agent.py'),
      '@tool("multiply", "x", {})\nasync def multiply(a): ...\ndef build_options():\n    return [multiply]\n',
    );
    const r = await scanRepo(cwd, { harnessDir: join(cwd, 'src', 'agent') });
    expect(r.harness).toBe('claude');
    // module name is relative to the harness folder, not the repo root.
    expect(r.entrypoint).toBe('agent:build_options');
    expect(r.tools).toEqual(['multiply']);
  });
});
