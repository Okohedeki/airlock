/**
 * airlock control — a long-lived local control plane for operating airlock workers.
 *
 * This is the backend for the `airlock control` admin app (an Airflow-style operations
 * console). It discovers worker.yaml projects, starts/stops them as managed child
 * processes, captures their logs, reads/validates/writes their manifests, detects the
 * framework of a project, runs doctor, and proxies to a running worker's own control
 * plane (/v1/control). Raw node:http — no framework dependency.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));

import { runUp, type UpHandle } from '../commands/up.js';
import { scanRepo } from '../scan.js';
import { validateWorker } from '../worker-schema/validate.js';

const LOG_CAP = 4000; // ring-buffer lines per worker
const PORT_BASE = 3030; // first port handed to a launched worker

type Status = 'stopped' | 'starting' | 'running' | 'exited' | 'error';

interface Worker {
  id: string;
  dir: string;
  file: string;
  name: string;
  harness: string;
  expose: string;
  status: Status;
  port?: number;
  url?: string;
  startedAt?: number;
  exitCode?: number;
  lastError?: string;
  logs: string[];
  handle?: UpHandle;
}

export interface ControlOptions {
  root: string;
  port: number;
  python?: string;
}

export function startControlServer(opts: ControlOptions) {
  const root = resolve(opts.root);
  const workers = new Map<string, Worker>();
  let nextPort = PORT_BASE;

  const slug = (dir: string) =>
    (relative(root, dir) || dir.split('/').pop() || 'worker').replace(/[\\/]/g, ':') || 'root';

  function readManifest(file: string): Record<string, unknown> {
    try {
      return (parseYaml(readFileSync(file, 'utf8')) as Record<string, unknown>) || {};
    } catch {
      return {};
    }
  }

  /** Walk `root` (depth-limited) for worker.yaml files and merge with live state. */
  function discover(): void {
    const found: string[] = [];
    const walk = (d: string, depth: number) => {
      if (depth > 4) return;
      let entries: string[] = [];
      try {
        entries = readdirSync(d);
      } catch {
        return;
      }
      if (entries.includes('worker.yaml')) found.push(join(d, 'worker.yaml'));
      for (const e of entries) {
        if (e.startsWith('.') || e === 'node_modules' || e === '__pycache__' || e.endsWith('.venv')) continue;
        const p = join(d, e);
        try {
          if (statSync(p).isDirectory()) walk(p, depth + 1);
        } catch {
          /* ignore */
        }
      }
    };
    walk(root, 0);
    for (const file of found) {
      const dir = dirname(file);
      const id = slug(dir);
      const m = readManifest(file);
      const wk = (m.worker as Record<string, unknown>) || {};
      const existing = workers.get(id);
      if (existing) {
        existing.name = String(wk.name || existing.name);
        existing.harness = String(m.harness || existing.harness);
        existing.expose = String(m.expose || 'internal');
      } else {
        workers.set(id, {
          id, dir, file, status: 'stopped', logs: [],
          name: String(wk.name || id), harness: String(m.harness || '—'),
          expose: String(m.expose || 'internal'),
        });
      }
    }
  }

  const pushLog = (w: Worker, chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.length) w.logs.push(line);
    }
    if (w.logs.length > LOG_CAP) w.logs.splice(0, w.logs.length - LOG_CAP);
  };

  const pyBin = () =>
    opts.python ||
    process.env.AIRLOCK_PYTHON ||
    [join(root, 'python/agent-runtime/.venv/bin/python'), join(root, '.venv/bin/python')].find((p) =>
      existsSync(p),
    ) ||
    'python3';

  async function start(w: Worker, port?: number): Promise<void> {
    if (w.status === 'running' || w.status === 'starting') return;
    const assigned = port || w.port || nextPort++;
    w.port = assigned;
    w.status = 'starting';
    w.logs = [];
    w.exitCode = undefined;
    w.lastError = undefined;
    pushLog(w, `[control] starting ${w.name} on :${assigned} (python ${pyBin()})`);

    // Pipe child stdio into the per-worker log buffer and inject PYTHONPATH so example
    // workers find their tools/agent modules (mirrors `PYTHONPATH=$PWD airlock up`).
    const pipingSpawn = ((bin: string, args: readonly string[], options: Record<string, unknown>) => {
      const env = { ...(options.env as Record<string, string>), PYTHONPATH: w.dir };
      const child = spawn(bin, args as string[], { ...options, env, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout?.on('data', (d: Buffer) => pushLog(w, d.toString()));
      child.stderr?.on('data', (d: Buffer) => pushLog(w, d.toString()));
      return child;
    }) as unknown as typeof spawn;

    try {
      const handle = await runUp({
        cwd: w.dir, port: assigned, noTunnel: true, python: pyBin(), spawnImpl: pipingSpawn,
      });
      w.handle = handle;
      w.status = 'running';
      w.url = handle.url;
      w.startedAt = Date.now();
      pushLog(w, `[control] healthy on http://127.0.0.1:${assigned}`);
      handle.done
        .then((code) => {
          w.status = w.status === 'running' ? 'exited' : w.status;
          w.exitCode = code;
          pushLog(w, `[control] process exited (code ${code})`);
        })
        .catch(() => {});
    } catch (err) {
      w.status = 'error';
      w.lastError = (err as Error).message;
      pushLog(w, `[control] failed to start: ${w.lastError}`);
    }
  }

  async function stop(w: Worker): Promise<void> {
    if (w.handle) {
      pushLog(w, '[control] stopping…');
      try {
        await w.handle.stop();
      } catch {
        /* ignore */
      }
    }
    w.handle = undefined;
    w.status = 'stopped';
    pushLog(w, '[control] stopped');
  }

  // ---- http helpers -------------------------------------------------------
  const send = (res: ServerResponse, code: number, body: unknown, type = 'application/json') => {
    const payload = type === 'application/json' ? JSON.stringify(body) : (body as string);
    res.writeHead(code, { 'content-type': type });
    res.end(payload);
  };
  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((r) => {
      const c: Buffer[] = [];
      req.on('data', (x) => c.push(x as Buffer));
      req.on('end', () => r(Buffer.concat(c).toString()));
    });
  const view = (w: Worker) => ({
    id: w.id, name: w.name, harness: w.harness, expose: w.expose, status: w.status,
    port: w.port, url: w.url, dir: relative(root, w.dir) || '.', startedAt: w.startedAt,
    exitCode: w.exitCode, lastError: w.lastError,
  });

  /** Reverse-proxy /api/workers/:id/proxy/<path> → the worker's own HTTP surface. */
  function proxy(w: Worker, subpath: string, req: IncomingMessage, res: ServerResponse): void {
    if (!w.port || w.status !== 'running') return send(res, 409, { error: 'worker not running' });
    const pr = httpRequest(
      { host: '127.0.0.1', port: w.port, path: '/' + subpath, method: req.method, headers: { 'content-type': 'application/json' } },
      (up) => {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
      },
    );
    pr.on('error', (e) => send(res, 502, { error: String(e) }));
    req.pipe(pr);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;
    try {
      if (path === '/' || path === '/index.html') {
        return send(res, 200, readFileSync(join(HERE, 'app.html'), 'utf8'), 'text/html');
      }
      if (path === '/healthz') return send(res, 200, { ok: true });

      if (path === '/api/workers' && req.method === 'GET') {
        discover();
        return send(res, 200, { root, workers: [...workers.values()].map(view) });
      }
      if (path === '/api/detect' && req.method === 'POST') {
        const { dir } = JSON.parse((await readBody(req)) || '{}');
        const target = resolve(root, dir || '.');
        const scan = await scanRepo(target);
        return send(res, 200, { dir: relative(root, target) || '.', ...scan });
      }

      const m = path.match(/^\/api\/workers\/([^/]+)(\/.*)?$/);
      if (m) {
        discover();
        const w = workers.get(decodeURIComponent(m[1] || ''));
        if (!w) return send(res, 404, { error: 'unknown worker' });
        const sub = m[2] || '';

        if (sub === '' && req.method === 'GET') return send(res, 200, view(w));
        if (sub === '/start' && req.method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}');
          await start(w, body.port);
          return send(res, 200, view(w));
        }
        if (sub === '/stop' && req.method === 'POST') {
          await stop(w);
          return send(res, 200, view(w));
        }
        if (sub === '/logs' && req.method === 'GET') return send(res, 200, { logs: w.logs.slice(-600) });
        if (sub === '/yaml' && req.method === 'GET') {
          const yaml = readFileSync(w.file, 'utf8');
          const v = validateWorker(parseYaml(yaml));
          return send(res, 200, { yaml, valid: v.ok, errors: v.errors });
        }
        if (sub === '/yaml' && req.method === 'PUT') {
          const { yaml } = JSON.parse((await readBody(req)) || '{}');
          let parsed: unknown;
          try {
            parsed = parseYaml(yaml);
          } catch (e) {
            return send(res, 400, { valid: false, errors: ['YAML parse error: ' + (e as Error).message] });
          }
          const v = validateWorker(parsed);
          if (!v.ok) return send(res, 400, { valid: false, errors: v.errors });
          writeFileSync(w.file, yaml);
          discover();
          return send(res, 200, { valid: true, errors: [], saved: true });
        }
        if (sub.startsWith('/proxy/')) return proxy(w, sub.slice('/proxy/'.length), req, res);
      }

      send(res, 404, { error: 'not found' });
    } catch (err) {
      send(res, 500, { error: (err as Error).message });
    }
  });

  // Graceful shutdown: stop every launched worker.
  const shutdown = async () => {
    for (const w of workers.values()) if (w.handle) await stop(w);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  discover();
  server.listen(opts.port, () => {
    console.log(`\n  ▸ airlock control  →  http://localhost:${opts.port}`);
    console.log(`    workspace: ${root}`);
    console.log(`    discovered ${workers.size} worker(s). Ctrl-C to stop.\n`);
  });
  return server;
}
