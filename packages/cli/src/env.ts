/**
 * Minimal `.env` loader (no dependency). Loads KEY=VALUE lines from a `.env` file
 * in the current directory into process.env at CLI startup. Values already present
 * in the environment win, so `EXPORTED=… airlock …` overrides the file.
 *
 * Used so a bring-your-own Cloudflare token (AIRLOCK_CF_TUNNEL_TOKEN) and model
 * keys can live in `.env` instead of being exported by hand. See `.env.example`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadDotEnv(cwd: string = process.cwd(), file = '.env'): string[] {
  const path = resolve(cwd, file);
  if (!existsSync(path)) return [];
  const loaded: string[] = [];
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
      loaded.push(key);
    }
  }
  return loaded;
}
