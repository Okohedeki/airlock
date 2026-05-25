/**
 * Heuristic scan of a Python agent repo to seed the `[agent]` config block.
 * Best-effort by design — `airlock init --detect` shows the result for the
 * developer to confirm or edit. Detects the harness from deps/imports and
 * locates a likely agent object or build_* factory as the entrypoint.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

export interface ScanResult {
  harness?: string;
  entrypoint?: string;
  /** Human-readable notes on what was (or wasn't) found. */
  evidence: string[];
}

// Import token / dependency name → harness id.
const HARNESS_SIGNATURES: { harness: string; deps: string[]; imports: RegExp }[] = [
  { harness: 'smolagents', deps: ['smolagents'], imports: /\b(from|import)\s+smolagents\b/ },
  { harness: 'langgraph', deps: ['langgraph'], imports: /\b(from|import)\s+langgraph\b/ },
  { harness: 'crewai', deps: ['crewai'], imports: /\b(from|import)\s+crewai\b/ },
  { harness: 'openai-agents', deps: ['openai-agents'], imports: /\bfrom\s+agents\s+import\b|\bimport\s+agents\b/ },
  { harness: 'claude', deps: ['claude-agent-sdk'], imports: /\b(from|import)\s+claude_agent_sdk\b/ },
];

const FACTORY_RE = /^\s*def\s+(build_\w+|make_\w+|create_\w+)\s*\(/m;
const OBJECT_RE = /^\s*(agent|graph|crew|app)\s*=/m;

async function pyFiles(dir: string, root: string, acc: string[], depth = 0): Promise<void> {
  if (depth > 4) return;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith('.') || name === 'node_modules' || name === '__pycache__') continue;
    const full = join(dir, name);
    const s = await stat(full).catch(() => null);
    if (!s) continue;
    if (s.isDirectory()) await pyFiles(full, root, acc, depth + 1);
    else if (name.endsWith('.py')) acc.push(full);
  }
}

/** Path → importable module name: strip `src/`, drop `.py`, `/` → `.`, drop trailing `.__init__`. */
function moduleName(file: string, root: string): string {
  let rel = relative(root, file).replace(/\.py$/, '');
  rel = rel.replace(/^src\//, '');
  let mod = rel.split('/').join('.');
  if (mod.endsWith('.__init__')) mod = mod.slice(0, -'.__init__'.length);
  return mod;
}

export async function scanRepo(cwd: string): Promise<ScanResult> {
  const evidence: string[] = [];
  const files: string[] = [];
  await pyFiles(cwd, cwd, files);

  // Read dependency manifests once.
  const manifests = (
    await Promise.all(
      ['requirements.txt', 'pyproject.toml'].map((f) =>
        readFile(join(cwd, f), 'utf8').catch(() => ''),
      ),
    )
  ).join('\n');

  // 1) Harness: prefer a dependency hit, fall back to an import hit.
  let harness: string | undefined;
  for (const sig of HARNESS_SIGNATURES) {
    if (sig.deps.some((d) => new RegExp(`(^|[^\\w-])${d}([^\\w-]|$)`, 'm').test(manifests))) {
      harness = sig.harness;
      evidence.push(`harness: ${sig.harness} (dependency)`);
      break;
    }
  }
  const contents = await Promise.all(
    files.map(async (f) => ({ f, text: await readFile(f, 'utf8').catch(() => '') })),
  );
  if (!harness) {
    for (const sig of HARNESS_SIGNATURES) {
      const hit = contents.find((c) => sig.imports.test(c.text));
      if (hit) {
        harness = sig.harness;
        evidence.push(`harness: ${sig.harness} (import in ${relative(cwd, hit.f)})`);
        break;
      }
    }
  }
  if (!harness) evidence.push('harness: not detected — set [agent].harness manually');

  // 2) Entrypoint: prefer a build_* factory, else a module-level agent object.
  let entrypoint: string | undefined;
  const factory = contents
    .map((c) => ({ c, m: FACTORY_RE.exec(c.text) }))
    .find((x) => x.m);
  if (factory?.m) {
    entrypoint = `${moduleName(factory.c.f, cwd)}:${factory.m[1]}`;
    evidence.push(`entrypoint: ${entrypoint} (factory in ${relative(cwd, factory.c.f)})`);
  } else {
    const obj = contents.map((c) => ({ c, m: OBJECT_RE.exec(c.text) })).find((x) => x.m);
    if (obj?.m) {
      entrypoint = `${moduleName(obj.c.f, cwd)}:${obj.m[1]}`;
      evidence.push(`entrypoint: ${entrypoint} (object in ${relative(cwd, obj.c.f)})`);
    } else {
      evidence.push('entrypoint: not found — set [agent].entrypoint to "module:your_agent"');
    }
  }

  return { harness, entrypoint, evidence };
}
