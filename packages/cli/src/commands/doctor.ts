import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ZodError } from 'zod';
import {
  type AirlockConfig,
  CF_TUNNEL_TOKEN_ENV,
  readConfig,
  validateTunnel,
} from '../config-file.js';
import { validateWorker } from '../worker-schema/validate.js';

const KNOWN_TARGETS = ['workers', 'fly'] as const;

/** Validate worker.yaml (C2 gate) + warn about container-hostile model endpoints. */
function checkWorkerYaml(cwd: string, findings: Finding[]): boolean {
  const path = resolve(cwd, 'worker.yaml');
  if (!existsSync(path)) return false;
  let manifest: Record<string, unknown>;
  try {
    manifest = parseYaml(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    findings.push({ level: 'error', message: `worker.yaml is not valid YAML: ${(err as Error).message}` });
    return true;
  }
  const { ok, errors } = validateWorker(manifest);
  if (!ok) {
    for (const e of errors) findings.push({ level: 'error', message: `worker.yaml ${e}` });
  } else {
    const w = (manifest.worker ?? {}) as { name?: string };
    findings.push({ level: 'ok', message: `worker.yaml valid (worker=${w.name ?? '<unnamed>'})` });
  }
  // Docker note: a host-run model on 127.0.0.1 is unreachable from inside a container.
  const models = (manifest.models ?? {}) as Record<string, { endpoint?: string }>;
  for (const [name, m] of Object.entries(models)) {
    const ep = m?.endpoint ?? '';
    if (/127\.0\.0\.1|localhost/.test(ep)) {
      findings.push({
        level: 'warn',
        message:
          `models.${name}.endpoint uses ${ep} — unreachable from inside a container. ` +
          'For `airlock up --docker` with a host-run model, use http://host.docker.internal:<port>.',
      });
    }
  }
  return true;
}

export interface DoctorReport {
  ok: boolean;
  findings: Finding[];
}

export interface Finding {
  level: 'ok' | 'warn' | 'error';
  message: string;
}

export async function runDoctor(cwd: string): Promise<DoctorReport> {
  const findings: Finding[] = [];

  // worker.yaml is the manifest of record (epic 07). Validate it if present.
  const hasWorker = checkWorkerYaml(cwd, findings);

  let config: AirlockConfig;
  try {
    config = await readConfig(cwd);
    findings.push({
      level: 'ok',
      message: `read .airlock/config.toml (project=${config.project?.name ?? '<unknown>'})`,
    });
  } catch (err) {
    if (hasWorker) {
      // worker.yaml-only project — no legacy config.toml is expected.
      return { ok: !findings.some((f) => f.level === 'error'), findings };
    }
    findings.push({
      level: 'error',
      message: `no worker.yaml or .airlock/config.toml — run \`airlock init <name>\` or \`airlock migrate\`. (${(err as Error).message})`,
    });
    return { ok: false, findings };
  }

  if (config.project?.schemaVersion !== 1) {
    findings.push({
      level: 'error',
      message: `unsupported config schemaVersion ${config.project?.schemaVersion}; this CLI knows version 1`,
    });
  }

  if (!KNOWN_TARGETS.includes(config.project?.target as (typeof KNOWN_TARGETS)[number])) {
    findings.push({
      level: 'error',
      message: `project.target must be one of ${KNOWN_TARGETS.join(' | ')}, got "${config.project?.target}"`,
    });
  }

  // Durable public URL (bring-your-own Cloudflare). Spell out exactly which keys
  // the publisher must provide — this is the headline of the durable-hosting flow.
  if (config.tunnel) {
    try {
      const t = validateTunnel(config);
      if (t?.durable) {
        const tokenSet = !!process.env[CF_TUNNEL_TOKEN_ENV];
        if (t.provider !== 'cloudflare') {
          findings.push({
            level: 'error',
            message: `tunnel.provider must be "cloudflare", got "${t.provider}"`,
          });
        }
        if (!t.hostname) {
          findings.push({
            level: 'error',
            message:
              'tunnel.durable=true but tunnel.hostname is unset — set it to the Public Hostname you routed in your Cloudflare Zero Trust dashboard',
          });
        }
        if (!tokenSet) {
          findings.push({
            level: 'error',
            message:
              `tunnel.durable=true but ${CF_TUNNEL_TOKEN_ENV} is not set — export your own Cloudflare Tunnel connector token ` +
              '(Zero Trust → Networks → Tunnels → your tunnel → token). airlock holds no Cloudflare keys.',
          });
        }
        if (t.hostname && tokenSet) {
          findings.push({
            level: 'ok',
            message: `durable tunnel ready: https://${t.hostname} via your Cloudflare account (${CF_TUNNEL_TOKEN_ENV} set)`,
          });
        }
      } else {
        findings.push({
          level: 'ok',
          message: 'tunnel: ephemeral quick tunnel (durable=false) — no Cloudflare account needed',
        });
      }
    } catch (err) {
      if (err instanceof ZodError) {
        for (const issue of err.issues) {
          findings.push({
            level: 'error',
            message: `tunnel.${issue.path.join('.')}: ${issue.message}`,
          });
        }
      } else {
        findings.push({
          level: 'error',
          message: `tunnel config invalid: ${(err as Error).message}`,
        });
      }
    }
  }

  if (config.agent) {
    const { harness, entrypoint } = config.agent;
    const known = ['smolagents', 'langgraph', 'crewai', 'openai-agents', 'claude', 'custom'];
    if (!harness || !known.includes(harness)) {
      findings.push({
        level: 'error',
        message: `agent.harness must be one of ${known.join(' | ')}, got "${harness}"`,
      });
    }
    if (!entrypoint || !/^[\w.]+:[\w.]+$/.test(entrypoint)) {
      findings.push({
        level: 'error',
        message: `agent.entrypoint must be "module:attr", got "${entrypoint ?? '<missing>'}"`,
      });
    } else if (entrypoint.startsWith('CHANGE_ME')) {
      findings.push({
        level: 'error',
        message: 'agent.entrypoint is the placeholder — set it to your agent (module:attr)',
      });
    } else {
      findings.push({ level: 'ok', message: `agent: ${harness} → ${entrypoint}` });
      const leaf = entrypoint.split(':')[1]?.split('.').pop() ?? '';
      const isFactory = /^(build_|make_|create_|get_)/.test(leaf);
      const perCall = config.agent.build_per_call ?? isFactory;
      if (perCall) {
        findings.push({
          level: 'ok',
          message:
            'concurrency: per-call rebuild on (fresh agent per request, isolated). ' +
            'Keep the model out-of-process (a model server / remote API) so rebuild is cheap and parallel.',
        });
      } else {
        findings.push({
          level: 'warn',
          message:
            'concurrency: per-call rebuild off (one shared agent). Stateful harnesses clamp to 1 ' +
            'in-flight run unless AIRLOCK_ALLOW_UNSAFE_PARALLEL=1; expose a build_* factory to parallelize.',
        });
      }
    }
  }

  const ok = !findings.some((f) => f.level === 'error');
  return { ok, findings };
}
