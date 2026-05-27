/**
 * Public-tunnel orchestration. airlock is the wrapper, so exposing the local
 * endpoint to the internet is part of the product — not a manual `cloudflared`
 * side-quest the publisher has to install and run themselves.
 *
 * We bundle the `cloudflared` npm package (a CLI dependency) and download its
 * binary on first use, so `npx @airlockhq/cli serve --tunnel` Just Works with
 * nothing else installed. (First-party tunnel infra is still deferred — this
 * only orchestrates Cloudflare's quick tunnels, see ADR-0001.)
 */

import { existsSync } from 'node:fs';
import { bin, install, Tunnel } from 'cloudflared';

export interface TunnelHandle {
  /** The public https URL (quick: …trycloudflare.com; durable: your own hostname). */
  url: string;
  /** Tear the tunnel down. */
  stop: () => void;
}

/**
 * Connector tuning passed straight to cloudflared. Defaults are cloudflared's
 * own; set these to cut per-request latency (region pin), pick the multiplexed
 * transport (protocol), or expose saturation metrics.
 */
export interface TunnelTuning {
  /** Edge protocol — `quic` (multiplexed, recommended) / `http2` / `auto`. */
  protocol?: 'quic' | 'http2' | 'auto';
  /** Pin the connector to a Cloudflare region (e.g. `us`) to cut backbone RTT. */
  region?: string;
  /** Expose cloudflared's metrics server on this address (host:port). */
  metrics?: string;
}

type CfOptions = Record<string, string | number | boolean>;

/** Translate our tuning into cloudflared CLI flag options (keys are literal flags). */
export function cfOptions(t: TunnelTuning = {}): CfOptions {
  const o: CfOptions = {};
  if (t.protocol) o['--protocol'] = t.protocol;
  if (t.region) o['--region'] = t.region;
  if (t.metrics) o['--metrics'] = t.metrics;
  return o;
}

/** Ensure the bundled cloudflared binary is present, downloading it once if not. */
export async function ensureCloudflared(): Promise<void> {
  if (existsSync(bin)) return;
  console.log('  cloudflared not found — downloading it once (bundled with airlock)…');
  await install(bin);
}

/**
 * Open a public Cloudflare quick-tunnel to http://localhost:PORT and resolve
 * once the public URL is assigned. The caller owns teardown via `stop()`.
 * (Quick tunnels aren't supervised: a respawn would mint a *new* throwaway URL,
 * which would break callers — durable named tunnels are the path to supervise.)
 */
export async function startTunnel(
  port: number,
  opts: { timeoutMs?: number; tuning?: TunnelTuning } = {},
): Promise<TunnelHandle> {
  await ensureCloudflared();

  // Account-less "quick" tunnel — no Cloudflare login, throwaway *.trycloudflare.com URL.
  const t = Tunnel.quick(`http://localhost:${port}`, cfOptions(opts.tuning));

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      t.stop();
      reject(new Error('cloudflared did not return a public URL within 30s'));
    }, opts.timeoutMs ?? 30_000);

    t.once('url', (u: string) => {
      clearTimeout(timer);
      resolve(u);
    });
    t.once('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
    t.once('exit', (code: number | null) => {
      clearTimeout(timer);
      reject(new Error(`cloudflared exited before opening a tunnel (code ${code ?? 'null'})`));
    });
  });

  return { url, stop: () => t.stop() };
}

/**
 * The minimal connector surface we depend on — cloudflared's `Tunnel` satisfies
 * it. Declared so supervision can be unit-tested with a fake connector.
 */
export interface Connector {
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  stop(): void;
}

export type ConnectorFactory = (token: string, options: CfOptions) => Connector;

const defaultBackoffMs = (attempt: number): number => Math.min(30_000, 500 * 2 ** attempt);

export interface NamedTunnelOptions {
  /** The publisher's own Cloudflare Tunnel connector token (from their account). */
  token: string;
  /** The stable public hostname the publisher routed to this tunnel (their domain). */
  hostname: string;
  timeoutMs?: number;
  tuning?: TunnelTuning;
  /**
   * Respawn the connector on unexpected exit (default true). The hostname is
   * stable, so a reconnect resumes serving the same URL — this closes the
   * "cloudflared dies → outage" gap without changing the public address.
   */
  supervise?: boolean;
  /** Injectables for tests. */
  connectorFactory?: ConnectorFactory;
  backoffMs?: (attempt: number) => number;
}

/**
 * Open a DURABLE Cloudflare named tunnel using the publisher's OWN account.
 *
 * Bring-your-own: the publisher creates the tunnel + a Public Hostname
 * (their domain → http://localhost:PORT) in their Cloudflare Zero Trust
 * dashboard and hands us the connector token. We only run the connector —
 * airlock holds no Cloudflare keys and never owns the domain. Unlike a quick
 * tunnel, the ingress (hostname → service) lives Cloudflare-side, so cloudflared
 * emits no `url`; we resolve on the first connection and report the publisher's
 * configured hostname. The dashboard's Public Hostname MUST point at the same
 * local PORT the agent listens on.
 */
export async function startNamedTunnel(
  port: number,
  opts: NamedTunnelOptions,
): Promise<TunnelHandle> {
  // A custom connector factory (tests) bypasses the bundled binary entirely.
  if (!opts.connectorFactory) await ensureCloudflared();

  // Named tunnel: `cloudflared tunnel run --token <token>`. Ingress is configured
  // in the publisher's Cloudflare account, not passed here, so `port` is only the
  // local service the dashboard hostname must target (we surface it for the hint).
  void port;
  const options = cfOptions(opts.tuning);
  const make: ConnectorFactory =
    opts.connectorFactory ?? ((token, o) => Tunnel.withToken(token, o) as unknown as Connector);
  const supervise = opts.supervise ?? true;
  const backoff = opts.backoffMs ?? defaultBackoffMs;

  let stopped = false;
  let attempt = 0;
  let respawnTimer: ReturnType<typeof setTimeout> | undefined;
  let current = make(opts.token, options);

  // Attach the keep-it-alive handlers to a (re)spawned connector: reset backoff
  // on connect, log errors, and on an unexpected exit reconnect after a backoff.
  const watch = (t: Connector): void => {
    t.on('connected', () => {
      attempt = 0;
    });
    t.on('error', (err: unknown) => {
      console.error(`  cloudflared connector error: ${(err as Error)?.message ?? err}`);
    });
    t.once('exit', (code: unknown) => {
      if (stopped || !supervise) return;
      const delay = backoff(attempt++);
      console.error(
        `  cloudflared connector exited (code ${(code as number) ?? 'null'}); ` +
          `reconnecting in ${Math.round(delay / 1000)}s…`,
      );
      respawnTimer = setTimeout(() => {
        if (stopped) return;
        current = make(opts.token, options);
        watch(current);
      }, delay);
    });
  };

  // First attempt fails fast (reject) so `up` surfaces a bad token/hostname
  // instead of silently retrying forever; supervision starts only after connect.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      current.stop();
      reject(new Error('cloudflared did not connect the named tunnel within 30s'));
    }, opts.timeoutMs ?? 30_000);

    current.once('connected', () => {
      clearTimeout(timer);
      resolve();
    });
    current.once('error', (err: unknown) => {
      clearTimeout(timer);
      reject(err as Error);
    });
    current.once('exit', (code: unknown) => {
      clearTimeout(timer);
      reject(
        new Error(
          `cloudflared exited before connecting the named tunnel (code ${(code as number) ?? 'null'})`,
        ),
      );
    });
  });

  watch(current);

  const url = /^https?:\/\//.test(opts.hostname) ? opts.hostname : `https://${opts.hostname}`;
  return {
    url,
    stop: () => {
      stopped = true;
      if (respawnTimer) clearTimeout(respawnTimer);
      current.stop();
    },
  };
}
