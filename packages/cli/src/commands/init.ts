import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AirlockConfig, type DeployMode, type Target, writeConfig } from '../config-file.js';
import { scanRepo } from '../scan.js';
import { type AgentHarness, flyAgentStarter } from '../templates/fly-agent.js';

export interface InitOptions {
  cwd: string;
  name: string;
  target: Target;
  /** Write a starter Recipe config (`wrangler.toml` or `fly.toml`) alongside ours. */
  scaffoldRecipe?: boolean;
  /** Scaffold a harness-backed agentic service (Fly-only). */
  harness?: AgentHarness;
  /** Scan an existing repo, detect the harness + entrypoint, and write [agent]. */
  detect?: boolean;
  /** Harness FOLDER to scan (`--detect <dir>`); defaults to the whole repo (cwd). */
  detectDir?: string;
  /** Deploy mode. `self-hosted` runs on the publisher's own hardware via `airlock up`. */
  mode?: DeployMode;
}

export interface InitResult {
  configPath: string;
  recipePath?: string;
  /** Paths of starter-agent files written when `harness` is set. */
  agentPaths?: string[];
  /** Detection result + files written when `detect` is set. */
  detected?: { harness?: string; entrypoint?: string; tools: string[]; evidence: string[] };
  detectPaths?: string[];
}

const RUNTIME_DOCKERFILE = `FROM python:3.11-slim
WORKDIR /app
# airlock runtime is vendored into the build context (not yet on PyPI); install
# it from local source FIRST so the harness deps below resolve against it.
COPY .airlock/vendor /app/.airlock/vendor
RUN pip install --no-cache-dir \\
    /app/.airlock/vendor/agent-runtime
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV PORT=3000
EXPOSE 3000
# Config-driven: reads .airlock/config.toml [agent] and drives your harness.
# Model is publisher-supplied — set OPENAI_API_BASE / OPENAI_API_KEY (ADR-0008).
# Concurrency: AIRLOCK_MAX_CONCURRENCY caps parallel runs (default 4); callers
# beyond it queue, beyond AIRLOCK_MAX_QUEUE they get 429. For real parallelism
# keep the model OUT OF PROCESS (a model server / remote API), not loaded in the
# factory — the runtime rebuilds a fresh agent per request for isolation (ADR-0010).
# Scale out via Fly machines (see fly.toml), not extra uvicorn worker processes.
CMD ["python", "-m", "airlock_agent"]
`;

/**
 * The airlock Python packages, resolved relative to this module. Compiled to
 * `packages/cli/dist/commands/init.js` (and run from `src/commands/init.ts`
 * under vitest); the repo root is four levels up in both layouts.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const VENDOR_PACKAGES: ReadonlyArray<{ name: string; src: string }> = [
  { name: 'agent-runtime', src: resolve(REPO_ROOT, 'python/agent-runtime') },
];
const VENDOR_EXCLUDES = ['/.venv', '/__pycache__', '/.pytest_cache', '.egg-info', '/tests', '/.git'];

/**
 * Copy the airlock Python package sources into `<cwd>/.airlock/vendor/<name>`
 * so the generated Dockerfile can `pip install` them locally. Removes Blocker 0
 * (the packages aren't on PyPI, so a bare `pip install airlock-agent` fails).
 */
async function vendorAirlockPackages(cwd: string): Promise<string[]> {
  const written: string[] = [];
  for (const { name, src } of VENDOR_PACKAGES) {
    const ok = await stat(src).then(
      (s) => s.isDirectory(),
      () => false,
    );
    if (!ok) {
      throw new Error(
        `cannot vendor airlock runtime: ${src} not found. Run \`airlock init --detect\` ` +
          `from a checkout of the airlock repo (the Python packages live under ./python).`,
      );
    }
    const dest = resolve(cwd, '.airlock/vendor', name);
    await cp(src, dest, {
      recursive: true,
      filter: (s) => !VENDOR_EXCLUDES.some((ex) => s.includes(ex)),
    });
    written.push(dest);
  }
  return written;
}

const WRANGLER_STARTER = (name: string) => `name = "${name}"
main = "src/index.ts"
compatibility_date = "2025-10-01"

# secrets: \`wrangler secret put OPENAI_API_KEY\`
# custom domain: \`wrangler deploy --routes …\`
`;

const FLY_STARTER = (name: string) => `app = "${name}"
primary_region = "iad"

[build]

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  # Keep one machine warm to avoid cold-start latency on the first paid call.
  # Set to 0 to scale to zero (cheaper, but adds cold-start latency).
  min_machines_running = 1
  # Horizontal scale: start more machines when a machine passes soft_limit.
  max_machines_running = 5

  # Per-machine request concurrency. Keep soft_limit ~= AIRLOCK_MAX_CONCURRENCY
  # (the in-process parallel-run cap); requests past it spill to another machine,
  # and hard_limit leaves headroom for the in-process queue before Fly sheds load.
  [http_service.concurrency]
    type = "requests"
    soft_limit = 4
    hard_limit = 20
`;

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const config: AirlockConfig = {
    project: { name: opts.name, target: opts.target, schemaVersion: 1 },
  };
  if (opts.mode) config.project.mode = opts.mode;

  // Detect mode: scan an existing repo and bind its harness via the [agent] block.
  let detected: InitResult['detected'];
  let detectPaths: string[] | undefined;
  if (opts.detect) {
    const harnessDir = opts.detectDir ? resolve(opts.cwd, opts.detectDir) : undefined;
    const scan = await scanRepo(opts.cwd, { harnessDir });
    detected = scan;
    config.agent = {
      harness: scan.harness ?? 'custom',
      entrypoint: scan.entrypoint ?? 'CHANGE_ME:your_agent',
    };
    detectPaths = [];
    // Vendor the airlock runtime into the build context (not yet on PyPI).
    detectPaths.push(...(await vendorAirlockPackages(opts.cwd)));
    // Dockerfile that installs the vendored runtime, then runs it (no app.py).
    const dockerfile = resolve(opts.cwd, 'Dockerfile');
    await writeFile(dockerfile, RUNTIME_DOCKERFILE, 'utf8');
    detectPaths.push(dockerfile);
    // requirements.txt carries only the harness's own deps — airlock-agent is
    // vendored + installed from source, so a bare line for it is unresolvable
    // and must not be present.
    const reqPath = resolve(opts.cwd, 'requirements.txt');
    const existing = await readFile(reqPath, 'utf8').catch(() => null);
    if (existing === null) {
      await writeFile(
        reqPath,
        '# Harness dependencies. airlock-agent is vendored under .airlock/vendor.\n',
        'utf8',
      );
      detectPaths.push(reqPath);
    } else if (/^airlock-agent\b/m.test(existing)) {
      const cleaned = existing
        .split('\n')
        .filter((l) => !/^airlock-agent\b/.test(l))
        .join('\n');
      await writeFile(reqPath, cleaned, 'utf8');
      detectPaths.push(reqPath);
    }
  }

  const configPath = await writeConfig(opts.cwd, config);

  let recipePath: string | undefined;
  // Self-host (hardware) runs via `airlock up`, not a cloud deploy — so it needs
  // no wrangler.toml/fly.toml Recipe. The cloud self-host variant uses `--target`
  // without `--self-host` and keeps the Recipe.
  if (opts.scaffoldRecipe !== false && opts.mode !== 'self-hosted') {
    const recipeName = opts.target === 'workers' ? 'wrangler.toml' : 'fly.toml';
    recipePath = resolve(opts.cwd, recipeName);
    const recipeContent =
      opts.target === 'workers' ? WRANGLER_STARTER(opts.name) : FLY_STARTER(opts.name);
    await writeFile(recipePath, recipeContent, 'utf8');
  }

  if (opts.harness && opts.target !== 'fly') {
    throw new Error(`--agent=${opts.harness} requires --target=fly (Python harnesses run on Fly)`);
  }

  let agentPaths: string[] | undefined;
  if (opts.harness) {
    const files = flyAgentStarter(opts.name, opts.harness);
    agentPaths = [];
    for (const file of files) {
      const dest = resolve(opts.cwd, file.path);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, file.content, 'utf8');
      agentPaths.push(dest);
    }
  }

  return { configPath, recipePath, agentPaths, detected, detectPaths };
}
