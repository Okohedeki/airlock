import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { PaymentConfigSchema } from '@airlockhq/payment-core';
import { parse, stringify } from 'smol-toml';
import { z } from 'zod';

export type Target = 'workers' | 'fly';

/** Env var that carries the publisher's own Cloudflare Tunnel connector token. */
export const CF_TUNNEL_TOKEN_ENV = 'AIRLOCK_CF_TUNNEL_TOKEN';

/**
 * Optional `[tunnel]` block. Opt in to a DURABLE public URL on the publisher's
 * OWN Cloudflare account (a named tunnel under their own domain) instead of the
 * default ephemeral *.trycloudflare.com quick tunnel. The connector token is a
 * secret read from the {@link CF_TUNNEL_TOKEN_ENV} env var — never the file.
 */
export const TunnelConfigSchema = z
  .object({
    durable: z.boolean().default(false),
    provider: z.literal('cloudflare').default('cloudflare'),
    /** The publisher's own stable hostname routed to this tunnel (e.g. agent.example.com). */
    hostname: z.string().min(1).optional(),
    /** cloudflared edge protocol — quic (multiplexed, default) / http2 / auto. */
    protocol: z.enum(['quic', 'http2', 'auto']).optional(),
    /** Pin the connector to a Cloudflare region (e.g. "us") to cut backbone RTT. */
    region: z.string().min(1).optional(),
    /** Expose cloudflared's metrics server on this address (host:port) for saturation visibility. */
    metrics: z.string().min(1).optional(),
  })
  .strict();

export type TunnelConfig = z.infer<typeof TunnelConfigSchema>;

/**
 * Who runs the agent's compute. `self-hosted` = the publisher's own hardware
 * (Mac mini / server / a cloud they own), fronted by an airlock tunnel.
 * `airlock-hosted` = airlock runs a per-agent microVM on its own org.
 * Optional for back-compat; absent ≈ self-hosted-on-your-own-cloud (the
 * original `target`-driven deploy).
 */
export type DeployMode = 'self-hosted' | 'airlock-hosted';

/**
 * On-disk shape of `.airlock/config.toml`. The `[payment]` section is
 * parsed via the shared PaymentConfigSchema from payment-core.
 */
export interface AirlockConfig {
  project: {
    name: string;
    target: Target;
    /** Deploy mode (see DeployMode). Optional; defaults applied per command. */
    mode?: DeployMode;
    /** Schema version of this file. Bump on breaking changes; reject older. */
    schemaVersion: 1;
  };
  payment?: Record<string, unknown>;
  /** Durable public-URL config (see TunnelConfigSchema). Absent = ephemeral quick tunnel. */
  tunnel?: Record<string, unknown>;
  /**
   * Binds a Harness to the agent runtime. The `airlock-agent` package imports
   * `entrypoint` once at startup and drives it with the built-in adapter for
   * `harness` — the developer writes no adapter (see ADR-0007).
   */
  agent?: {
    harness: string;
    /** Python import path "module:attr" to the agent object or a build_* factory. */
    entrypoint: string;
    /**
     * Rebuild a fresh agent wrapper per request for concurrency isolation
     * (ADR-0010). Defaults at runtime to true for `build_*` factory entrypoints,
     * false for bare instances. Set false to force one shared object.
     */
    build_per_call?: boolean;
  };
}

export const CONFIG_PATH = '.airlock/config.toml';

export async function readConfig(cwd: string): Promise<AirlockConfig> {
  const path = resolve(cwd, CONFIG_PATH);
  const raw = await readFile(path, 'utf8');
  return parse(raw) as unknown as AirlockConfig;
}

export async function writeConfig(cwd: string, config: AirlockConfig): Promise<string> {
  const path = resolve(cwd, CONFIG_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stringify(config as unknown as Record<string, unknown>), 'utf8');
  return path;
}

/**
 * Validate just the `[payment]` section. Returns the parsed PaymentConfig or
 * throws a ZodError. Callers pretty-print the error message.
 */
export function validatePayment(config: AirlockConfig) {
  if (!config.payment) return undefined;
  return PaymentConfigSchema.parse(config.payment);
}

/**
 * Validate just the `[tunnel]` section. Returns the parsed TunnelConfig or
 * throws a ZodError. Returns undefined when there's no `[tunnel]` block.
 */
export function validateTunnel(config: AirlockConfig): TunnelConfig | undefined {
  if (!config.tunnel) return undefined;
  return TunnelConfigSchema.parse(config.tunnel);
}
