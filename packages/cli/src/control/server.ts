/**
 * airlock control — a long-lived local control plane for operating airlock workers.
 *
 * This is the backend for the `airlock control` admin app (an Airflow-style operations
 * console). It discovers worker.yaml projects, starts/stops them as managed child
 * processes, captures their logs, reads/validates/writes their manifests, detects the
 * framework of a project, runs doctor, and proxies to a running worker's own control
 * plane (/v1/control). Raw node:http — no framework dependency.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, parseDocument } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));

import { runUp, type UpHandle } from '../commands/up.js';
import { resolveBuildPlan, runBuild } from '../commands/build.js';
import type { Spawner } from '../exec.js';
import { scanRepo } from '../scan.js';
import { validateWorker } from '../worker-schema/validate.js';
import { ROLES } from './seed.js';
import { ControlStore } from './store.js';
import { can, currentUser, login as authLogin, logout as authLogout } from './auth.js';

const RANK: Record<string, number> = { viewer: 0, auditor: 1, approver: 1, operator: 2, owner: 3 };

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

  // Durable, real state: users/roles/SSO/environments + an append-only audit log on disk.
  const store = new ControlStore(root);
  const audit = (actor: string, action: string, target: string, detail: string, env = 'dev') =>
    store.appendAudit({ actor, action, target, detail, env });

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

  // ---- real per-worker aggregation (from the worker's own manifest + HTTP surface) ----
  const manifestOf = (w: Worker) => readManifest(w.file);
  const workerTenantList = (w: Worker): string[] => {
    const keys = ((manifestOf(w).tenancy as Record<string, unknown>) || {}).keys as Record<string, string> | undefined;
    return Array.from(new Set(['default', ...(keys ? Object.values(keys) : [])]));
  };
  const price1k = (w: Worker): number => {
    const p = (manifestOf(w).pricing as Record<string, any>) || {};
    const d = p.default || (p.models && p.models.default) || {};
    return Number(d.per_1k || d.usd_per_1k || 0);
  };
  interface RunRow { id: string; workerId: string; worker: string; tenant: string; status: string; steps: number; tokens: number; started: number; costUsd: number; }
  async function runsOf(w: Worker): Promise<RunRow[]> {
    if (w.status !== 'running' || !w.port) return [];
    const price = price1k(w);
    const out: RunRow[] = [];
    const seen = new Set<string>(); // a run belongs to one tenant; dedupe across tenant queries
    for (const t of workerTenantList(w)) {
      const d = await fetchJSON(w.port, '/v1/runs?tenant=' + encodeURIComponent(t));
      for (const r of (d?.runs || [])) {
        if (seen.has(r.run_id)) continue;
        seen.add(r.run_id);
        out.push({
          id: r.run_id, workerId: w.id, worker: w.name, tenant: r.tenant || t,
          status: r.status, steps: r.n_steps || 0, tokens: r.tokens || 0, started: (r.started || 0) * 1000,
          costUsd: Math.round((r.tokens || 0) / 1000 * price * 1e4) / 1e4,
        });
      }
    }
    return out;
  }
  const statsOf = (runs: RunRow[]) => {
    const errors = runs.filter((r) => r.status === 'error' || r.status === 'stopped').length;
    return {
      runs: runs.length, tokens: runs.reduce((a, r) => a + r.tokens, 0),
      cost: Math.round(runs.reduce((a, r) => a + r.costUsd, 0) * 1e4) / 1e4,
      errPct: runs.length ? Math.round((errors / runs.length) * 1000) / 10 : 0,
    };
  };
  const modelsOf = (w: Worker) => {
    const m = manifestOf(w);
    const models = (m.models as Record<string, any>) || {};
    const def = ((m.routing as Record<string, unknown>) || {}).default as string || 'default';
    return {
      default: def,
      bindings: Object.entries(models).map(([name, c]) => ({
        name, model: (c && c.model) || name, endpoint: (c && c.endpoint) || '(stub / echo)',
        env_key: (c && c.env_key) || 'OPENAI_API_KEY', isDefault: name === def,
      })),
    };
  };

  const skillsOf = (w: Worker): Array<{ id: string; tool: string; enabled: boolean }> => {
    const skills = (manifestOf(w).skills as Record<string, any>) || {};
    return Object.entries(skills).map(([id, spec]) =>
      typeof spec === 'object' && spec
        ? { id, tool: String(spec.tool || id), enabled: spec.enabled !== false }
        : { id, tool: String(spec), enabled: true },
    );
  };

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

  /** True if a docker image with this tag exists locally (skip rebuild). */
  const dockerImageExists = (image: string): boolean =>
    spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }).status === 0;

  async function start(w: Worker, port?: number): Promise<void> {
    if (w.status === 'running' || w.status === 'starting') return;
    const assigned = port || w.port || nextPort++;
    w.port = assigned;
    w.status = 'starting';
    w.logs = [];
    w.exitCode = undefined;
    w.lastError = undefined;

    // Pipe child stdio into the per-worker log buffer. In host mode we inject
    // PYTHONPATH so example workers find their modules; in docker mode the image's
    // /app/worker is already the cwd, so PYTHONPATH is harmless.
    const pipingSpawn = ((bin: string, args: readonly string[], options: Record<string, unknown>) => {
      const env = { ...(options.env as Record<string, string>), PYTHONPATH: w.dir };
      const child = spawn(bin, args as string[], { ...options, env, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout?.on('data', (d: Buffer) => pushLog(w, d.toString()));
      child.stderr?.on('data', (d: Buffer) => pushLog(w, d.toString()));
      return child;
    }) as unknown as typeof spawn;
    // Capturing spawner for `docker build` output → the worker's log buffer.
    const buildSpawner: Spawner = (b, a, cwd) =>
      new Promise((resolve) => {
        const child = spawn(b, a, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout?.on('data', (d: Buffer) => pushLog(w, d.toString()));
        child.stderr?.on('data', (d: Buffer) => pushLog(w, d.toString()));
        child.on('error', (e) => { pushLog(w, String(e)); resolve(1); });
        child.on('exit', (c) => resolve(c ?? 0));
      });

    // Default: run the worker as a Docker container — the HOST needs only Docker, no
    // Python runtime or harness deps (that's the whole point of shipping a Docker image).
    // `airlock control --python <bin>` (or AIRLOCK_PYTHON) opts into legacy host mode.
    const hostMode = !!(opts.python || process.env.AIRLOCK_PYTHON);
    let runOpts: Parameters<typeof runUp>[0];
    if (hostMode) {
      pushLog(w, `[control] starting ${w.name} on :${assigned} (host python ${pyBin()})`);
      runOpts = { cwd: w.dir, port: assigned, noTunnel: true, python: pyBin(), spawnImpl: pipingSpawn };
    } else {
      let image: string;
      try {
        image = resolveBuildPlan({ cwd: w.dir }).image; // content-addressed: same manifest ⇒ same image
        if (!dockerImageExists(image)) {
          pushLog(w, `[control] building image ${image} (first run; this can take a minute)…`);
          const code = await runBuild({ cwd: w.dir, spawnImpl: buildSpawner }).then(() => 0).catch((e) => {
            pushLog(w, `[control] ${(e as Error).message}`);
            return 1;
          });
          if (code !== 0 || !dockerImageExists(image)) throw new Error('docker build did not produce the image');
        }
      } catch (err) {
        w.status = 'error';
        const cause = lastErrorLine(w);
        w.lastError = `docker build failed${cause ? ` — ${cause}` : `: ${(err as Error).message}`}`;
        pushLog(w, `[control] ${w.lastError}`);
        return;
      }
      pushLog(w, `[control] starting ${w.name} on :${assigned} (docker ${image})`);
      runOpts = { cwd: w.dir, port: assigned, noTunnel: true, docker: true, image, spawnImpl: pipingSpawn };
    }

    try {
      const handle = await runUp(runOpts);
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
      // Surface the REAL cause (e.g. "ModuleNotFoundError: No module named
      // 'claude_agent_sdk'") in lastError, not just the generic health-timeout —
      // otherwise the dashboard can't tell you a harness dep or the runtime is missing.
      const cause = lastErrorLine(w);
      w.lastError = cause ? `${(err as Error).message} — ${cause}` : (err as Error).message;
      pushLog(w, `[control] failed to start: ${w.lastError}`);
    }
  }

  /** Most informative line from a worker's captured output (skips our own [control] lines). */
  function lastErrorLine(w: Worker): string | undefined {
    const lines = w.logs.filter((l) => !l.startsWith('[control]'));
    const hit = [...lines]
      .reverse()
      .find((l) => /error|exception|traceback|no module|errno|refused|denied|not found/i.test(l));
    return (hit || lines[lines.length - 1])?.trim();
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
    const wk = (readManifest(w.file).worker as Record<string, unknown>) || {};
    const md = modelsOf(w);
    const def = md.bindings.find((b) => b.isDefault);
    const sk = skillsOf(w);
    return {
      id: w.id, name: w.name, harness: w.harness, expose: w.expose, status: w.status,
      port: w.port, url: w.url, dir: relative(root, w.dir) || '.', startedAt: w.startedAt,
      exitCode: w.exitCode, lastError: w.lastError,
      env: store.workerEnv(w.id), version: 'v' + String(wk.version || '0.0.0'),
      models: md.bindings.length, model: md.default,
      modelName: def ? def.model : (md.bindings[0] ? md.bindings[0].model : '—'),
      skillsOn: sk.filter((s) => s.enabled).length, skillsTotal: sk.length,
      health: w.status === 'running' ? 'healthy' : w.status === 'error' ? 'error' : 'idle',
    };
  };
  // A worker row enriched with REAL run stats (runs / tokens / errors / cost).
  const viewStats = async (w: Worker) => ({ ...view(w), ...statsOf(await runsOf(w)) });

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

      // ---- identity + RBAC ----------------------------------------------------
      const user = currentUser(store, req);
      if (path === '/api/me') {
        return send(res, 200, { user, sso: { enforced: store.sso().enforced, provider: store.sso().provider } });
      }
      // Pre-auth directory for the sign-in picker (names/emails/roles only — no secrets).
      if (path === '/api/login-users') {
        return send(res, 200, { users: store.users().map((u) => ({ name: u.name, email: u.email, role: u.role })), sso: { enforced: store.sso().enforced, provider: store.sso().provider } });
      }
      if (path === '/api/login' && req.method === 'POST') {
        const { email, password } = JSON.parse((await readBody(req)) || '{}');
        const r = authLogin(store, res, String(email || ''), password);
        if (r.ok && r.user) audit(r.user.name, 'auth.login', 'session', 'signed in');
        return send(res, r.ok ? 200 : 401, r);
      }
      if (path === '/api/logout' && req.method === 'POST') {
        if (user) audit(user.name, 'auth.logout', 'session', 'signed out');
        authLogout(req, res);
        return send(res, 200, { ok: true });
      }
      // Everything else under /api requires an authenticated user.
      if (path.startsWith('/api/') && !user) return send(res, 401, { error: 'authentication required' });

      // Permission gate: 403 + audit on deny. Returns false when denied (caller returns).
      const need = (perm: string): boolean => {
        if (!user) { send(res, 401, { error: 'authentication required' }); return false; }
        if (!can(user.role, perm)) {
          audit(user.name, 'access.denied', perm, `role ${user.role} lacks ${perm}`);
          send(res, 403, { error: `forbidden — ${perm} is not permitted for role "${user.role}"` });
          return false;
        }
        return true;
      };
      // Environment change-control: the worker's env may demand a higher role.
      const envOk = (envId: string): boolean => {
        const pol = store.envPolicy(envId);
        if ((RANK[user!.role] ?? 0) < (RANK[pol.minRole] ?? 0)) {
          audit(user!.name, 'access.denied', envId, `${envId} requires ${pol.minRole}+`);
          send(res, 403, { error: `forbidden — ${envId} change-control requires ${pol.minRole}+ (you are ${user!.role})` });
          return false;
        }
        return true;
      };

      if (path === '/api/workers' && req.method === 'GET') {
        discover();
        const rows = await Promise.all([...workers.values()].map(viewStats));
        return send(res, 200, { root, environments: store.environments(), workers: rows });
      }
      if (path === '/api/detect' && req.method === 'POST') {
        const { dir } = JSON.parse((await readBody(req)) || '{}');
        const target = resolve(root, dir || '.');
        const scan = await scanRepo(target);
        return send(res, 200, { dir: relative(root, target) || '.', ...scan });
      }
      if (path === '/api/environments') return send(res, 200, { environments: store.environments(), policy: store.get().envPolicy });

      // ---- fleet aggregation (REAL data from discovered workers) -----------
      async function allRuns(): Promise<RunRow[]> {
        const all: RunRow[] = [];
        for (const w of workers.values()) all.push(...(await runsOf(w)));
        return all;
      }
      const heldCount = async (): Promise<number> => {
        let n = 0;
        for (const w of workers.values()) if (w.status === 'running' && w.port) n += ((await fetchJSON(w.port, '/v1/runs/held'))?.held || []).length;
        return n;
      };
      if (path === '/api/overview' && req.method === 'GET') {
        discover();
        const now = Date.now();
        const real = [...workers.values()];
        const runs = await allRuns();
        const errors = runs.filter((r) => r.status === 'error' || r.status === 'stopped').length;
        const bucket = (n: number, ms: number, val: (r: RunRow) => number) => {
          const out = Array.from({ length: n }, (_, i) => ({ t: now - (n - 1 - i) * ms, v: 0 }));
          for (const r of runs) { const h = Math.floor((now - r.started) / ms); if (r.started && h >= 0 && h < n) out[n - 1 - h]!.v += val(r); }
          return out;
        };
        const byTenant: Record<string, { name: string; runs24h: number; tokens24h: number; costMtd: number; plan: string }> = {};
        for (const r of runs) { (byTenant[r.tenant] ||= { name: r.tenant, runs24h: 0, tokens24h: 0, costMtd: 0, plan: 'tenant' }); const t = byTenant[r.tenant]!; t.runs24h++; t.tokens24h += r.tokens; t.costMtd += r.costUsd; }
        return send(res, 200, {
          kpi: {
            workersLive: real.filter((w) => w.status === 'running').length, workersTotal: real.length,
            runs24h: runs.length, errorRatePct: runs.length ? Math.round((errors / runs.length) * 1000) / 10 : 0,
            tokens24h: runs.reduce((a, r) => a + r.tokens, 0), spend24h: Math.round(runs.reduce((a, r) => a + r.costUsd, 0) * 100) / 100,
            pendingApprovals: await heldCount(),
          },
          environments: store.environments(),
          runVolume: bucket(24, 3600_000, () => 1),
          cost: bucket(24, 3600_000, (r) => r.costUsd),
          topTenants: Object.values(byTenant).map((t) => ({ ...t, costMtd: Math.round(t.costMtd * 100) / 100 })).sort((a, b) => b.tokens24h - a.tokens24h).slice(0, 6),
          alerts: real.filter((w) => w.status === 'error').map((w) => ({ sev: 'crit', worker: w.name, msg: w.lastError || 'failed to start', env: store.workerEnv(w.id) })),
        });
      }
      if (path === '/api/runs' && req.method === 'GET') {
        discover();
        const runs = (await allRuns()).map((r) => ({ ...r, ageMins: r.started ? Math.max(0, Math.round((Date.now() - r.started) / 60000)) : null }));
        return send(res, 200, { runs: runs.sort((a, b) => (b.started || 0) - (a.started || 0)) });
      }
      if (path === '/api/approvals' && req.method === 'GET') {
        discover();
        const held: unknown[] = [];
        for (const w of workers.values()) {
          if (w.status === 'running' && w.port) {
            const d = await fetchJSON(w.port, '/v1/runs/held');
            for (const h of (d?.held || [])) held.push({ ...h, worker: w.name, workerId: w.id, env: store.workerEnv(w.id), live: true });
          }
        }
        return send(res, 200, { held });
      }
      if (path === '/api/models' && req.method === 'GET') {
        discover();
        const rows: unknown[] = [];
        for (const w of workers.values()) { const md = modelsOf(w); for (const b of md.bindings) rows.push({ ...b, worker: w.name, workerId: w.id, env: store.workerEnv(w.id) }); }
        return send(res, 200, { models: rows });
      }
      if (path === '/api/tenants' && req.method === 'GET') {
        discover();
        const runs = await allRuns();
        const map: Record<string, { id: string; name: string; runs24h: number; tokens24h: number; costMtd: number; status: string; plan: string }> = {};
        for (const w of workers.values()) for (const t of workerTenantList(w)) map[t] ||= { id: t, name: t, runs24h: 0, tokens24h: 0, costMtd: 0, status: 'active', plan: 'declared' };
        for (const r of runs) { (map[r.tenant] ||= { id: r.tenant, name: r.tenant, runs24h: 0, tokens24h: 0, costMtd: 0, status: 'active', plan: 'active' }); const t = map[r.tenant]!; t.runs24h++; t.tokens24h += r.tokens; t.costMtd += r.costUsd; }
        return send(res, 200, { tenants: Object.values(map).map((t) => ({ ...t, costMtd: Math.round(t.costMtd * 100) / 100 })) });
      }
      if (path === '/api/access' && req.method === 'GET')
        return send(res, 200, {
          users: store.users().map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, sso: u.sso, lastActiveMins: u.lastActiveMins })),
          roles: ROLES, sso: store.sso(), environments: store.environments(), policy: store.get().envPolicy,
        });
      if (path === '/api/access' && req.method === 'POST') {
        if (!need('access:write')) return;
        const body = JSON.parse((await readBody(req)) || '{}');
        if (body.setRole) {
          store.setUserRole(body.setRole.email, body.setRole.role);
          audit(user!.name, 'access.role_change', body.setRole.email, `→ ${body.setRole.role}`);
        } else if (body.addUser) {
          store.addUser({ id: 'u-' + Date.now(), name: body.addUser.name, email: body.addUser.email, role: body.addUser.role || 'viewer', sso: true, lastActiveMins: 0 });
          audit(user!.name, 'access.user_add', body.addUser.email, `role ${body.addUser.role || 'viewer'}`);
        } else if (body.sso) {
          store.setSso(body.sso);
          audit(user!.name, 'access.sso', 'sso', `enforced=${body.sso.enforced}`);
        }
        return send(res, 200, { ok: true });
      }
      if (path === '/api/audit' && req.method === 'GET') {
        if (!need('audit:read')) return;
        const now = Date.now();
        return send(res, 200, { events: store.readAudit(300).map((e) => ({ ...e, tsMins: Math.max(0, Math.round((now - e.ts) / 60000)) })) });
      }
      if (path === '/api/cost' && req.method === 'GET') {
        discover();
        const now = Date.now();
        const runs = await allRuns();
        const byEnvMap: Record<string, number> = {};
        for (const w of workers.values()) byEnvMap[store.workerEnv(w.id)] ||= 0;
        const byTenant: Record<string, { name: string; costMtd: number; runs: number; plan: string }> = {};
        const days = Array.from({ length: 30 }, (_, i) => ({ t: now - (29 - i) * 86400_000, v: 0 }));
        for (const r of runs) {
          const w = workers.get(r.workerId); const e = w ? store.workerEnv(w.id) : 'dev';
          byEnvMap[e] = (byEnvMap[e] || 0) + r.costUsd;
          (byTenant[r.tenant] ||= { name: r.tenant, costMtd: 0, runs: 0, plan: 'active' }); byTenant[r.tenant]!.costMtd += r.costUsd; byTenant[r.tenant]!.runs++;
          const d = Math.floor((now - r.started) / 86400_000); if (r.started && d >= 0 && d < 30) days[29 - d]!.v += r.costUsd;
        }
        return send(res, 200, {
          series: days,
          tenants: Object.values(byTenant).map((t) => ({ ...t, costMtd: Math.round(t.costMtd * 100) / 100 })).sort((a, b) => b.costMtd - a.costMtd),
          byEnv: Object.entries(byEnvMap).map(([env, cost]) => ({ env, cost: Math.round(cost * 100) / 100 })),
          budget: 0,
        });
      }

      const m = path.match(/^\/api\/workers\/([^/]+)(\/.*)?$/);
      if (m) {
        discover();
        const w = workers.get(decodeURIComponent(m[1] || ''));
        if (!w) return send(res, 404, { error: 'unknown worker' });
        const sub = m[2] || '';

        const wenv = store.workerEnv(w.id);
        if (sub === '' && req.method === 'GET') return send(res, 200, view(w));
        if (sub === '/start' && req.method === 'POST') {
          if (!need('workers:start') || !envOk(wenv)) return;
          const body = JSON.parse((await readBody(req)) || '{}');
          await start(w, body.port);
          audit(user!.name, 'worker.start', w.name, `started on :${w.port}`, wenv);
          return send(res, 200, view(w));
        }
        if (sub === '/stop' && req.method === 'POST') {
          if (!need('workers:stop') || !envOk(wenv)) return;
          await stop(w);
          audit(user!.name, 'worker.stop', w.name, 'stopped', wenv);
          return send(res, 200, view(w));
        }
        if (sub === '/env' && req.method === 'PUT') {
          if (!need('env:write')) return;
          const { env } = JSON.parse((await readBody(req)) || '{}');
          store.setWorkerEnv(w.id, String(env));
          audit(user!.name, 'worker.env', w.name, `environment → ${env}`, String(env));
          return send(res, 200, view(w));
        }
        if (sub === '/expose' && req.method === 'PUT') {
          if (!need('exposure:write') || !envOk(wenv)) return;
          const { expose } = JSON.parse((await readBody(req)) || '{}');
          const val = expose === 'public' ? 'public' : 'internal';
          const doc = parseDocument(readFileSync(w.file, 'utf8'));
          doc.setIn(['expose'], val);
          const v = validateWorker(doc.toJS() || {});
          if (!v.ok) return send(res, 400, { valid: false, errors: v.errors });
          writeFileSync(w.file, String(doc));
          discover();
          audit(user!.name, 'exposure.flip', w.name, `→ ${val}`, wenv);
          return send(res, 200, { ok: true, expose: val });
        }
        if (sub === '/skills' && req.method === 'GET') return send(res, 200, { skills: skillsOf(w), running: w.status === 'running' });
        if (sub === '/skills' && req.method === 'PUT') {
          if (!need('workers:config')) return;
          const { id, enabled } = JSON.parse((await readBody(req)) || '{}');
          const doc = parseDocument(readFileSync(w.file, 'utf8')); // preserves comments/formatting
          const cur = doc.getIn(['skills', id]);
          if (cur && typeof cur !== 'string') doc.setIn(['skills', id, 'enabled'], !!enabled);
          else doc.setIn(['skills', id], { tool: typeof cur === 'string' ? cur : id, enabled: !!enabled });
          const v = validateWorker(doc.toJS() || {});
          if (!v.ok) return send(res, 400, { valid: false, errors: v.errors });
          writeFileSync(w.file, String(doc));
          discover();
          // Apply live too, if the worker is running (so the change takes effect immediately).
          if (w.status === 'running' && w.port) {
            await new Promise<void>((done) => {
              const pr = httpRequest({ host: '127.0.0.1', port: w.port, path: '/v1/control/skills/' + encodeURIComponent(id), method: 'POST', headers: { 'content-type': 'application/json' } }, () => done());
              pr.on('error', () => done());
              pr.end(JSON.stringify({ enabled: !!enabled }));
            });
          }
          audit(user!.name, 'skill.toggle', w.name, `${id} ${enabled ? 'enabled' : 'disabled'}`, wenv);
          return send(res, 200, { ok: true, skills: skillsOf(w) });
        }
        if (sub === '/model' && req.method === 'GET') return send(res, 200, modelsOf(w));
        if (sub === '/model' && req.method === 'PUT') {
          if (!need('workers:config')) return;
          const body = JSON.parse((await readBody(req)) || '{}');
          const doc = parseDocument(readFileSync(w.file, 'utf8')); // preserves comments/formatting
          if (body.setDefault) {
            doc.setIn(['routing', 'default'], body.setDefault);
          } else {
            const { name, model, endpoint, env_key } = body;
            if (endpoint !== undefined) doc.setIn(['models', name, 'endpoint'], endpoint);
            if (model !== undefined) doc.setIn(['models', name, 'model'], model);
            if (env_key) doc.setIn(['models', name, 'env_key'], env_key);
          }
          const v = validateWorker(doc.toJS() || {});
          if (!v.ok) return send(res, 400, { valid: false, errors: v.errors });
          writeFileSync(w.file, String(doc));
          discover();
          audit(user!.name, 'model.update', w.name, body.setDefault ? `default → ${body.setDefault}` : `${body.name} updated`, wenv);
          return send(res, 200, { ok: true, ...modelsOf(w) });
        }
        if (sub === '/logs' && req.method === 'GET') return send(res, 200, { logs: w.logs.slice(-600) });
        if (sub === '/yaml' && req.method === 'GET') {
          const yaml = readFileSync(w.file, 'utf8');
          const v = validateWorker(parseYaml(yaml));
          return send(res, 200, { yaml, valid: v.ok, errors: v.errors });
        }
        if (sub === '/yaml' && req.method === 'PUT') {
          if (!need('workers:config')) return;
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
          audit(user!.name, 'config.save', w.name, 'edited worker.yaml', wenv);
          return send(res, 200, { valid: true, errors: [], saved: true });
        }
        if (sub.startsWith('/proxy/')) {
          const subpath = sub.slice('/proxy/'.length);
          if (req.method === 'POST' && subpath.includes('v1/control')) {
            if (!need('control:write') || !envOk(wenv)) return;
            const act = subpath.replace('v1/control/', 'control.').replace(/\/.*$/, '') || 'control.update';
            audit(user!.name, act.startsWith('control') ? act : 'control.update', w.name, subpath, wenv);
          } else if (req.method === 'POST' && subpath.includes('/decision')) {
            if (!need('approvals:decide')) return;
            audit(user!.name, 'approval.decide', w.name, subpath, wenv);
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
