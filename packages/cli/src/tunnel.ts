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
  /** The public https URL Cloudflare assigned (…trycloudflare.com). */
  url: string;
  /** Tear the tunnel down. */
  stop: () => void;
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
 */
export async function startTunnel(
  port: number,
  opts: { timeoutMs?: number } = {},
): Promise<TunnelHandle> {
  await ensureCloudflared();

  // Account-less "quick" tunnel — no Cloudflare login, throwaway *.trycloudflare.com URL.
  const t = Tunnel.quick(`http://localhost:${port}`);

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
