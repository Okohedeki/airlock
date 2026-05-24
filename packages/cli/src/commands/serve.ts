/**
 * `airlock serve` — wrap a locally-running LLM HTTP endpoint with
 * x402 payment enforcement and (optionally) dashboard reporting.
 *
 * The Publisher already has their model running somewhere — llama.cpp's
 * `llama-server`, Ollama, LM Studio, vLLM, OpenCoder, etc. All of those
 * expose an OpenAI-compatible `POST /v1/chat/completions` endpoint (Ollama
 * via `OLLAMA_OPENAI=1` or `/v1/...`). This server forwards to it.
 */

import type { AddressInfo } from 'node:net';
import {
  type CallReporter,
  type PaymentConfig,
  PaymentConfigSchema,
} from '@airlockhq/payment-core';
import { withPaymentExpress } from '@airlockhq/payment-fly-node';
import express, { type Express, type Request } from 'express';
import { readAuth } from '../auth-store.js';
import { readConfig } from '../config-file.js';
import { startTunnel, type TunnelHandle } from '../tunnel.js';

export interface ServeOptions {
  /** Local LLM URL. Defaults to llama-server's :8080. */
  upstream: string;
  /** Path on the upstream to forward to. Defaults to OpenAI's chat-completions. */
  upstreamPath?: string;
  /** Port for the wrapper to listen on. */
  port: number;
  /** Project name for the dashboard reporter (defaults to config.project.name). */
  projectName?: string;
  /** Backend URL for the dashboard reporter. */
  backendUrl?: string;
  /** Override the wallet (skip config.toml). */
  wallet?: string;
  /** Override the per-call price USDC (flat mode). Skip config.toml. */
  priceUsdc?: string;
  /** Force payment disabled. */
  noPayment?: boolean;
  /** Working directory to read config from. */
  cwd?: string;
  /** Expose the wrapper publicly via a bundled Cloudflare tunnel. */
  tunnel?: boolean;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
}

export interface ServeResolved {
  app: Express;
  paymentConfig: PaymentConfig;
  upstream: string;
  reporter?: CallReporter;
}

/**
 * Build the wrapper Express app from CLI options + .airlock/config.toml
 * + ~/.airlock/auth.json. Returns the app so tests can drive it without
 * binding a port.
 */
export async function buildServeApp(opts: ServeOptions): Promise<ServeResolved> {
  const cwd = opts.cwd ?? process.cwd();
  const paymentConfig = await resolvePaymentConfig(opts, cwd);
  const reporter = await resolveReporter(opts, cwd);
  const fetchFn = opts.fetchImpl ?? fetch;

  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.get('/', (_req, res) => {
    res.json({
      service: 'airlock serve',
      upstream: opts.upstream,
      payment: { enabled: paymentConfig.enabled, mode: paymentConfig.mode },
      endpoints: ['POST /v1/chat/completions', 'POST /chat'],
    });
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  const upstreamPath = opts.upstreamPath ?? '/v1/chat/completions';
  const handler = makeForwarder(opts.upstream, upstreamPath, fetchFn);
  const wrapped = withPaymentExpress(paymentConfig, handler, reporter ? { reporter } : {});

  app.post('/v1/chat/completions', wrapped);
  app.post('/chat', wrapped); // alias for clients that prefer a short path

  return { app, paymentConfig, upstream: opts.upstream, reporter };
}

/**
 * Listen on the configured port and return the Server. Caller is responsible
 * for closing it (e.g. on SIGINT).
 */
export async function startServe(opts: ServeOptions): Promise<{ close: () => Promise<void> }> {
  const { app, paymentConfig, upstream, reporter } = await buildServeApp(opts);
  return new Promise((resolve) => {
    const server = app.listen(opts.port, async () => {
      const addr = server.address() as AddressInfo;
      console.log(`airlock serve  →  listening on http://localhost:${addr.port}`);
      console.log(`  upstream:    ${upstream}`);
      console.log(
        `  payment:     ${paymentConfig.enabled ? `${paymentConfig.mode} (wallet=${paymentConfig.wallet})` : 'OFF'}`,
      );
      console.log(
        `  reporter:    ${reporter ? `→ ${reporter.url} (project=${reporter.projectName})` : 'OFF'}`,
      );
      console.log('\n  endpoints:');
      console.log('    POST /v1/chat/completions   (OpenAI-compatible)');
      console.log('    POST /chat                  (alias)');
      console.log('    GET  /                      (info)');
      console.log('    GET  /healthz');
      console.log(
        '\n  note: `serve` is a dev convenience (adds a proxy hop). In production,',
      );
      console.log('        mount the middleware in-process — see `airlock init --with-agent`.');

      let tunnel: TunnelHandle | undefined;
      if (opts.tunnel) {
        console.log('\n  opening public tunnel…');
        try {
          tunnel = await startTunnel(addr.port);
          console.log(`  public URL:  ${tunnel.url}`);
          console.log(`    callers POST to:  ${tunnel.url}/v1/chat/completions`);
        } catch (err) {
          console.error(`  tunnel failed: ${(err as Error).message}`);
        }
      } else {
        console.log('\n  expose publicly with:  airlock serve --tunnel');
      }

      resolve({
        close: () =>
          new Promise<void>((r) => {
            tunnel?.stop();
            server.close(() => r());
          }),
      });
    });
  });
}

function makeForwarder(upstream: string, upstreamPath: string, fetchFn: typeof fetch) {
  const path = upstreamPath.startsWith('/') ? upstreamPath : `/${upstreamPath}`;
  return async (req: Request) => {
    const body = req.body as { stream?: boolean; stream_options?: { include_usage?: boolean } };
    const wantsStream = body?.stream === true;

    // For streaming + per-token billing, the caller MUST opt into usage events
    // (OpenAI omits them by default in streams). We force-enable it.
    const upstreamBody = wantsStream
      ? { ...body, stream_options: { include_usage: true, ...(body.stream_options ?? {}) } }
      : body;

    const upstreamRes = await fetchFn(`${upstream.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(upstreamBody),
    });

    if (wantsStream && upstreamRes.body) {
      return {
        status: upstreamRes.status,
        headers: {
          'content-type': upstreamRes.headers.get('content-type') ?? 'text/event-stream',
          'cache-control': 'no-cache',
        },
        stream: upstreamRes.body,
      };
    }

    // Buffered (non-streaming) path
    const text = await upstreamRes.text();
    let respBody: unknown;
    let tokens = 0;
    try {
      const parsed = JSON.parse(text) as { usage?: { total_tokens?: number } };
      respBody = parsed;
      tokens = parsed.usage?.total_tokens ?? 0;
    } catch {
      respBody = text;
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (tokens > 0) headers['X-Tokens-Used'] = String(tokens);
    return { status: upstreamRes.status, headers, body: respBody };
  };
}

async function resolvePaymentConfig(opts: ServeOptions, cwd: string): Promise<PaymentConfig> {
  // Explicit override path: flags only, no config file required.
  if (opts.wallet || opts.priceUsdc || opts.noPayment) {
    return PaymentConfigSchema.parse({
      enabled: !opts.noPayment,
      wallet: opts.wallet ?? '0x0000000000000000000000000000000000000001',
      network: 'base-sepolia',
      mode: 'flat',
      priceUsdc: opts.priceUsdc ?? '0.001',
    });
  }
  // Otherwise read .airlock/config.toml
  const cfg = await readConfig(cwd);
  if (!cfg.payment) {
    throw new Error(
      'no [payment] section in .airlock/config.toml — run `airlock init` or pass --wallet / --price',
    );
  }
  return PaymentConfigSchema.parse(cfg.payment);
}

async function resolveReporter(opts: ServeOptions, cwd: string): Promise<CallReporter | undefined> {
  const token = process.env.AIRLOCK_TOKEN ?? (await readAuth())?.token;
  if (!token) return undefined;
  const backend = opts.backendUrl ?? process.env.AIRLOCK_BACKEND ?? (await readAuth())?.backend;
  if (!backend) return undefined;
  let projectName = opts.projectName;
  if (!projectName) {
    try {
      const cfg = await readConfig(cwd);
      projectName = cfg.project?.name;
    } catch {
      // no config file — no reporter
    }
  }
  if (!projectName) return undefined;
  return { url: backend, token, projectName };
}
