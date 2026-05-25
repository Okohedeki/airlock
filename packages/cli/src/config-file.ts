import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { PaymentConfigSchema } from '@airlockhq/payment-core';
import { parse, stringify } from 'smol-toml';

export type Target = 'workers' | 'fly';

/**
 * On-disk shape of `.airlock/config.toml`. The `[payment]` section is
 * parsed via the shared PaymentConfigSchema from payment-core.
 */
export interface AirlockConfig {
  project: {
    name: string;
    target: Target;
    /** Schema version of this file. Bump on breaking changes; reject older. */
    schemaVersion: 1;
  };
  payment?: Record<string, unknown>;
  /**
   * Binds a Harness to the agent runtime. The `airlock-agent` package imports
   * `entrypoint` once at startup and drives it with the built-in adapter for
   * `harness` — the developer writes no adapter (see ADR-0007).
   */
  agent?: {
    harness: string;
    /** Python import path "module:attr" to the agent object or a build_* factory. */
    entrypoint: string;
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
