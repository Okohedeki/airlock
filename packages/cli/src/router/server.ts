/**
 * The Fleet Router as a live HTTP service (epic 09). It runs the frozen routing
 * pipeline (router/index.ts) then **reverse-proxies** the request to the chosen worker
 * container — control stays inside each worker; the router only decides which one.
 *
 * Routing reads headers only (session/auth/capability), so the body is streamed
 * through untouched — SSE step streams and large payloads pass straight to the worker.
 *
 * A small control API drives canary rollout (epic 08):
 *   POST /_control/rollout  { stable, canary?: {version, pct} }
 *   POST /_control/promote  { version }      (100% → version)
 *   POST /_control/rollback                  (drop the canary; stable wins)
 *   GET  /_control/status                    (registry snapshot)
 */

import { createServer, type IncomingMessage, request as httpRequest, type Server, type ServerResponse } from 'node:http';

import { createRouter, type Registry, type RouteRequest } from './index.js';

export interface RouterServerOptions {
  /** Logical worker name the fleet serves (used as RouteRequest.worker). */
  worker: string;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function reqToRoute(req: IncomingMessage, worker: string): RouteRequest {
  const h = req.headers;
  const auth = (h.authorization as string) || '';
  const apiKey = auth.toLowerCase().startsWith('bearer ')
    ? auth.slice(7).trim()
    : (h['x-api-key'] as string | undefined);
  return {
    worker,
    sessionId: h['x-airlock-session'] as string | undefined,
    apiKey,
    capability: h['x-airlock-capability'] as string | undefined,
  };
}

/** Build (but don't start) the router HTTP server. */
export function createRouterServer(reg: Registry, opts: RouterServerOptions): Server {
  const route = createRouter(reg);

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || '/';

    // --- control API (epic 08) ---
    if (url.startsWith('/_control/')) {
      const body = await readBody(req);
      const json = body.length ? JSON.parse(body.toString()) : {};
      if (url === '/_control/status') {
        return sendJson(res, 200, {
          workers: reg.workers.map((w) => ({ id: w.id, version: w.version, variant: w.variant,
            port: w.port, healthy: w.healthy, inflight: w.inflight })),
          rollout: reg.rollouts.get(opts.worker) ?? null,
        });
      }
      if (url === '/_control/rollout') {
        reg.setRollout(opts.worker, { stable: json.stable, canary: json.canary });
        return sendJson(res, 200, { ok: true, rollout: reg.rollouts.get(opts.worker) });
      }
      if (url === '/_control/promote') {
        reg.setRollout(opts.worker, { stable: json.version });
        return sendJson(res, 200, { ok: true, promoted: json.version });
      }
      if (url === '/_control/rollback') {
        const cur = reg.rollouts.get(opts.worker);
        reg.setRollout(opts.worker, { stable: cur?.stable ?? '' }); // drop canary
        return sendJson(res, 200, { ok: true, stable: cur?.stable });
      }
      return sendJson(res, 404, { error: 'unknown control endpoint' });
    }

    if (url === '/healthz') return sendJson(res, 200, { ok: true });

    // --- route + reverse-proxy ---
    let ctx;
    try {
      ctx = await route(reqToRoute(req, opts.worker));
    } catch (err) {
      const msg = String((err as Error).message || err);
      const code = msg.startsWith('401') ? 401 : msg.startsWith('503') ? 503 : 502;
      return sendJson(res, code, { error: msg });
    }
    const target = ctx.target!;
    const proxy = httpRequest(
      { host: target.host, port: target.port, method: req.method, path: url, headers: req.headers },
      (upstream) => {
        res.writeHead(upstream.statusCode || 502, upstream.headers);
        upstream.pipe(res);
        upstream.on('end', () => { target.inflight = Math.max(0, target.inflight - 1); });
      },
    );
    proxy.on('error', (e) => {
      target.inflight = Math.max(0, target.inflight - 1);
      if (!res.headersSent) sendJson(res, 502, { error: `upstream ${target.id}: ${e.message}` });
    });
    req.pipe(proxy);
  });
}

function sendJson(res: ServerResponse, code: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(body);
}

/** Start the server on a port. */
export function startRouterServer(reg: Registry, opts: RouterServerOptions, port: number): Promise<Server> {
  const server = createRouterServer(reg, opts);
  return new Promise((resolve) => server.listen(port, '0.0.0.0', () => resolve(server)));
}
