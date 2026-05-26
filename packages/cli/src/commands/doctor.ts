import { ZodError } from 'zod';
import { type AirlockConfig, readConfig, validatePayment } from '../config-file.js';

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

  let config: AirlockConfig;
  try {
    config = await readConfig(cwd);
    findings.push({
      level: 'ok',
      message: `read .airlock/config.toml (project=${config.project?.name ?? '<unknown>'})`,
    });
  } catch (err) {
    findings.push({
      level: 'error',
      message: `no .airlock/config.toml — run \`airlock init <name> --target=workers|fly\`. (${(err as Error).message})`,
    });
    return { ok: false, findings };
  }

  if (config.project?.schemaVersion !== 1) {
    findings.push({
      level: 'error',
      message: `unsupported config schemaVersion ${config.project?.schemaVersion}; this CLI knows version 1`,
    });
  }

  if (config.project?.target !== 'workers' && config.project?.target !== 'fly') {
    findings.push({
      level: 'error',
      message: `project.target must be "workers" or "fly", got "${config.project?.target}"`,
    });
  }

  if (!config.payment) {
    findings.push({ level: 'warn', message: 'no [payment] section — Agent will be free to call' });
  } else {
    try {
      const parsed = validatePayment(config);
      if (parsed?.enabled) {
        findings.push({
          level: 'ok',
          message: `payment enabled (mode=${parsed.mode}, network=${parsed.network}, wallet=${parsed.wallet})`,
        });
        if (parsed.wallet === '0x0000000000000000000000000000000000000001') {
          findings.push({
            level: 'error',
            message:
              'payment.wallet is still the placeholder — set it to your wallet before enabling payment',
          });
        }
      } else if (parsed) {
        findings.push({ level: 'warn', message: 'payment configured but enabled=false' });
      }
    } catch (err) {
      if (err instanceof ZodError) {
        for (const issue of err.issues) {
          findings.push({
            level: 'error',
            message: `payment.${issue.path.join('.')}: ${issue.message}`,
          });
        }
      } else {
        findings.push({
          level: 'error',
          message: `payment config invalid: ${(err as Error).message}`,
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
