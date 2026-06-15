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
import {
  ENVIRONMENTS, ROLES, USERS, SSO, type AuditEvent,
  auditSeed, fleet as seedFleet, sampleRuns, series, tenants as seedTenants,
} from './seed.js';

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

  // Audit log: seeded history + live events appended as the operator acts (newest first).
  const liveAudit: AuditEvent[] = [];
  let auditN = 0;
  const OPERATOR = USERS[0]?.name || 'operator'; // signed-in operator (RBAC is representative)
  const audit = (actor: string, action: string, target: string, detail: string, env = 'dev') =>
    liveAudit.unshift({ id: `live-${auditN++}`, tsMins: 0, actor, action, target, detail, env });

  // Deterministic sample metrics for a worker id (real workers have no local traffic, so RPS/
  // p95/error/cost are representative — marked sample in the UI).
  const sampleMetrics = (id: string) => {
    let s = 0;
    for (const c of id) s = (Math.imul(s, 31) + c.charCodeAt(0)) >>> 0;
    const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    const errPct = Math.round(r() * 25) / 10;
    return { rps: Math.round(r() * 60 * 10) / 10, p95: 240 + Math.floor(r() * 1800), errPct,
      cost24h: Math.round(r() * 120 * 100) / 100, tenants: 1 + Math.floor(r() * 6),
      health: errPct > 4 ? 'degraded' : 'healthy' };
  };

  const fetchJSON = (port: number, path: string): Promise<any> =>
    new Promise((res) => {
      const rq = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (up) => {
        const c: Buffer[] = [];
        up.on('data', (x) => c.push(x as Buffer));
        up.on('end', () => { try { res(JSON.parse(Buffer.concat(c).toString())); } catch { res(null); } });
      });
      rq.on('error', () => res(null));
      rq.end();
    });

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
  const view = (w: Worker) => {
    const m = readManifest(w.file);
    const wk = (m.worker as Record<string, unknown>) || {};
    const sm = sampleMetrics(w.id);
    return {
      id: w.id, name: w.name, harness: w.harness, expose: w.expose, status: w.status,
      port: w.port, url: w.url, dir: relative(root, w.dir) || '.', startedAt: w.startedAt,
      exitCode: w.exitCode, lastError: w.lastError,
      env: 'dev', version: 'v' + String(wk.version || '0.0.0'),
      operable: true, sampleMetrics: true,
      health: w.status === 'running' ? sm.health : w.status === 'error' ? 'error' : 'idle',
      rps: sm.rps, p95: sm.p95, errPct: sm.errPct, cost24h: sm.cost24h, tenants: sm.tenants,
    };
  };

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
      if (path === '/app.css') return send(res, 200, readFileSync(join(HERE, 'app.css'), 'utf8'), 'text/css');
      if (path === '/app.js') return send(res, 200, readFileSync(join(HERE, 'app.js'), 'utf8'), 'text/javascript');
      if (path === '/healthz') return send(res, 200, { ok: true });

      if (path === '/api/workers' && req.method === 'GET') {
        discover();
        const real = [...workers.values()].map(view); // operable, real lifecycle
        return send(res, 200, { root, environments: ENVIRONMENTS, workers: [...real, ...seedFleet()] });
      }
      if (path === '/api/detect' && req.method === 'POST') {
        const { dir } = JSON.parse((await readBody(req)) || '{}');
        const target = resolve(root, dir || '.');
        const scan = await scanRepo(target);
        return send(res, 200, { dir: relative(root, target) || '.', ...scan });
      }
      if (path === '/api/environments') return send(res, 200, { environments: ENVIRONMENTS });

      // ---- fleet aggregation (live ⊕ seeded representative data) -----------
      if (path === '/api/overview' && req.method === 'GET') {
        discover();
        const now = Date.now();
        const real = [...workers.values()];
        const fl = seedFleet();
        const tns = seedTenants();
        const liveRunning = real.filter((w) => w.status === 'running').length;
        const kpi = {
          workersLive: liveRunning + fl.filter((w) => w.health !== 'error').length,
          workersTotal: real.length + fl.length,
          runs24h: tns.reduce((a, t) => a + t.runs24h, 0),
          errorRatePct: Math.round((fl.reduce((a, w) => a + w.errPct, 0) / fl.length) * 10) / 10,
          p95: Math.round(fl.reduce((a, w) => a + w.p95, 0) / fl.length),
          spend24h: Math.round(fl.reduce((a, w) => a + w.cost24h, 0) * 100) / 100,
          pendingApprovals: 3,
        };
        return send(res, 200, {
          kpi, environments: ENVIRONMENTS,
          runVolume: series(now, 24, 3200, 900, 0x11),
          latency: series(now, 24, 900, 280, 0x22),
          cost: series(now, 24, 320, 90, 0x33),
          topTenants: tns.slice().sort((a, b) => b.costMtd - a.costMtd).slice(0, 6),
          alerts: [
            { sev: 'crit', worker: 'sanctions-screen', msg: '2 runs held > 30m awaiting approval', env: 'prod' },
            { sev: 'warn', worker: 'fraud-review', msg: 'error rate 4.2% over 1h (SLO 2%)', env: 'prod' },
            { sev: 'info', worker: 'kyc-screening', msg: 'canary v2.5.0 at 10% — nominal', env: 'prod' },
          ],
          sample: true,
        });
      }
      if (path === '/api/runs' && req.method === 'GET') {
        discover();
        const live: unknown[] = [];
        for (const w of workers.values()) {
          if (w.status === 'running' && w.port) {
            const d = await fetchJSON(w.port, '/v1/runs?tenant=default');
            for (const r of (d?.runs || [])) live.push({
              id: r.run_id, worker: w.name, workerId: w.id, tenant: r.tenant || 'default',
              status: r.status, steps: r.n_steps, tokens: r.tokens, costUsd: 0, ageMins: 0, live: true,
            });
          }
        }
        return send(res, 200, { runs: [...live, ...sampleRuns(40)] });
      }
      if (path === '/api/approvals' && req.method === 'GET') {
        discover();
        const held: unknown[] = [];
        for (const w of workers.values()) {
          if (w.status === 'running' && w.port) {
            const d = await fetchJSON(w.port, '/v1/runs/held');
            for (const h of (d?.held || [])) held.push({ ...h, worker: w.name, workerId: w.id, live: true });
          }
        }
        const seeded = [
          { run: 'run_8c21', tool: 'send', args: { to: 'customer@globex.com', body: 'claim approved' }, worker: 'claims-adjudicator', ageMins: 41, env: 'prod', sample: true },
          { run: 'run_4f0a', tool: 'transfer', args: { amount: 12500, acct: '****8842' }, worker: 'sanctions-screen', ageMins: 33, env: 'prod', sample: true },
          { run: 'run_2b7e', tool: 'refund', args: { order: 'SO-77213', usd: 480 }, worker: 'returns-resolver', ageMins: 9, env: 'staging', sample: true },
        ];
        return send(res, 200, { held: [...held, ...seeded] });
      }
      if (path === '/api/tenants' && req.method === 'GET') return send(res, 200, { tenants: seedTenants(), sample: true });
      if (path === '/api/access' && req.method === 'GET')
        return send(res, 200, { users: USERS, roles: ROLES, sso: SSO, environments: ENVIRONMENTS, sample: true });
      if (path === '/api/audit' && req.method === 'GET')
        return send(res, 200, { events: [...liveAudit, ...auditSeed()], sample: true });
      if (path === '/api/cost' && req.method === 'GET') {
        const now = Date.now();
        return send(res, 200, {
          series: series(now, 30, 7600, 1800, 0x44),
          tenants: seedTenants().slice().sort((a, b) => b.costMtd - a.costMtd),
          byEnv: [{ env: 'prod', cost: 18420.55 }, { env: 'staging', cost: 2110.2 }, { env: 'dev', cost: 340.18 }],
          budget: 32000, sample: true,
        });
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
          audit(OPERATOR, 'worker.start', w.name, `started on :${w.port}`);
          return send(res, 200, view(w));
        }
        if (sub === '/stop' && req.method === 'POST') {
          await stop(w);
          audit(OPERATOR, 'worker.stop', w.name, 'stopped');
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
          audit(OPERATOR, 'config.save', w.name, 'edited worker.yaml');
          return send(res, 200, { valid: true, errors: [], saved: true });
        }
        if (sub.startsWith('/proxy/')) {
          const subpath = sub.slice('/proxy/'.length);
          if (req.method === 'POST' && subpath.includes('v1/control')) {
            const act = subpath.replace('v1/control/', 'control.').replace(/\/.*$/, '') || 'control.update';
            audit(OPERATOR, act.startsWith('control') ? act : 'control.update', w.name, subpath);
          }
          return proxy(w, subpath, req, res);
        }
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
