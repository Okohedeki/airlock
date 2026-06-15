/**
 * Heuristic scan of a Python agent repo to seed the `[agent]` config block.
 * Best-effort by design — `airlock init --detect [dir]` shows the result for the
 * developer to confirm or edit. Detects the harness from deps/imports and locates
 * the harness's areas: a likely build_* factory or agent object (the entrypoint)
 * and the tools it declares.
 *
 * `--detect <dir>` points the scan at a specific harness FOLDER: file/module names
 * are then resolved relative to that folder (so `./src/agent/agent.py` declares the
 * entrypoint as `agent:build_options`), while dependency manifests are still read
 * from the folder AND the project root. With no dir, the whole repo (cwd) is scanned.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

export interface ScanResult {
  harness?: string;
  entrypoint?: string;
  /** Tool/skill names the harness declares (e.g. `@tool("multiply")`). */
  tools: string[];
  /** Human-readable notes on what was (or wasn't) found. */
  evidence: string[];
}

export interface ScanOptions {
  /**
   * Harness folder to scan (`--detect <dir>`). Module names are resolved relative
   * to it; manifests are read from it and the project root. Defaults to the root.
   */
  harnessDir?: string;
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

// Tool declarations across SDKs: `@tool("name", ...)` (claude/openai sdk) and
// `@function_tool` over a `def name(...)` (openai-agents). Best-effort.
const TOOL_DECORATOR_RE = /@tool\(\s*["']([^"']+)["']/g;
const FUNCTION_TOOL_RE = /@function_tool[^\n]*\n\s*(?:async\s+)?def\s+(\w+)/g;

async function pyFiles(dir: string, acc: string[], depth = 0): Promise<void> {
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
    if (s.isDirectory()) await pyFiles(full, acc, depth + 1);
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

/** Collect declared tool names from one file's source. */
function toolsIn(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(TOOL_DECORATOR_RE)) if (m[1]) found.push(m[1]);
  for (const m of text.matchAll(FUNCTION_TOOL_RE)) if (m[1]) found.push(m[1]);
  return found;
}

export async function scanRepo(projectRoot: string, opts: ScanOptions = {}): Promise<ScanResult> {
  const evidence: string[] = [];
  const files: string[] = [];
  // Scan the harness folder when given, else the whole repo. Module names resolve
  // relative to that folder so a `--detect ./src/agent` yields `agent:build_options`.
  const scanDir = opts.harnessDir ?? projectRoot;
  const moduleRoot = opts.harnessDir ?? projectRoot;
  await pyFiles(scanDir, files);
  if (opts.harnessDir) evidence.push(`scanned folder: ${relative(projectRoot, scanDir) || '.'}`);

  // Read dependency manifests from the harness folder AND the project root.
  const manifestDirs =
    opts.harnessDir && opts.harnessDir !== projectRoot ? [opts.harnessDir, projectRoot] : [projectRoot];
  const manifests = (
    await Promise.all(
      manifestDirs.flatMap((d) =>
        ['requirements.txt', 'pyproject.toml'].map((f) => readFile(join(d, f), 'utf8').catch(() => '')),
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
        evidence.push(`harness: ${sig.harness} (import in ${relative(projectRoot, hit.f)})`);
        break;
      }
    }
  }
  if (!harness) evidence.push('harness: not detected — set [agent].harness manually');

  // 2) Entrypoint: prefer a build_* factory, else a module-level agent object.
  let entrypoint: string | undefined;
  const factory = contents.map((c) => ({ c, m: FACTORY_RE.exec(c.text) })).find((x) => x.m);
  if (factory?.m) {
    entrypoint = `${moduleName(factory.c.f, moduleRoot)}:${factory.m[1]}`;
    evidence.push(`entrypoint: ${entrypoint} (factory in ${relative(projectRoot, factory.c.f)})`);
  } else {
    const obj = contents.map((c) => ({ c, m: OBJECT_RE.exec(c.text) })).find((x) => x.m);
    if (obj?.m) {
      entrypoint = `${moduleName(obj.c.f, moduleRoot)}:${obj.m[1]}`;
      evidence.push(`entrypoint: ${entrypoint} (object in ${relative(projectRoot, obj.c.f)})`);
    } else {
      evidence.push('entrypoint: not found — set [agent].entrypoint to "module:your_agent"');
    }
  }

  // 3) Tools: the harness's other "area" — surface what it declares.
  const tools = [...new Set(contents.flatMap((c) => toolsIn(c.text)))];
  if (tools.length) evidence.push(`tools: ${tools.join(', ')}`);
  else evidence.push('tools: none detected — declare them in worker.yaml `tools:` if needed');

  return { harness, entrypoint, tools, evidence };
}
