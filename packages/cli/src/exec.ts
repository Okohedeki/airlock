import { spawn } from 'node:child_process';
import type { AirlockConfig, Target } from './config-file.js';

export type Spawner = (binary: string, args: string[], cwd: string) => Promise<number>;

/** Production spawner — inherits stdio so the publisher sees real-time output. */
export const inheritSpawner: Spawner = (binary, args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, stdio: 'inherit' });
    child.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new TargetBinaryMissingError(binary));
      } else {
        reject(err);
      }
    });
    child.on('exit', (code) => resolve(code ?? 0));
  });

export class TargetBinaryMissingError extends Error {
  constructor(public readonly binary: string) {
    super(`${binary} not found on PATH`);
    this.name = 'TargetBinaryMissingError';
  }
}

/** Throw a clear error for legacy `target='fly'` configs — Fly deploy is no longer supported. */
function assertWorkers(target: Target): void {
  if (target !== 'workers') {
    throw new Error(
      `project.target must be "workers" (got "${target}"). Fly deploy is no longer supported; ` +
        `update .airlock/config.toml or self-host via \`airlock up\`.`,
    );
  }
}

/** Map a Target to the publisher's CLI binary name. */
export function targetBinary(target: Target): string {
  assertWorkers(target);
  return 'wrangler';
}

/** Install-hint URL printed when the target binary is missing. */
export function installUrlFor(target: Target): string {
  assertWorkers(target);
  return 'https://developers.cloudflare.com/workers/wrangler/install-and-update/';
}

export interface CommandBuild {
  binary: string;
  args: string[];
}

/** `airlock deploy` — pushes the project to its Target. */
export function buildDeploy(config: AirlockConfig): CommandBuild {
  assertWorkers(config.project.target);
  return { binary: 'wrangler', args: ['deploy'] };
}

/** `airlock delete` — tears down the deployment. */
export function buildDelete(config: AirlockConfig): CommandBuild {
  assertWorkers(config.project.target);
  return { binary: 'wrangler', args: ['delete'] };
}

/** `airlock logs` — stream live logs from the deployment. */
export function buildLogs(config: AirlockConfig): CommandBuild {
  assertWorkers(config.project.target);
  return { binary: 'wrangler', args: ['tail'] };
}

export type SecretAction = 'set' | 'list' | 'rm';

/** `airlock secret set NAME=value | list | rm NAME` */
export function buildSecret(
  config: AirlockConfig,
  action: SecretAction,
  arg?: string,
): CommandBuild {
  assertWorkers(config.project.target);
  if (action === 'set') {
    const name = (arg ?? '').split('=', 1)[0];
    if (!name) throw new Error('secret set requires NAME=VALUE');
    return { binary: 'wrangler', args: ['secret', 'put', name] };
  }
  if (action === 'list') return { binary: 'wrangler', args: ['secret', 'list'] };
  if (!arg) throw new Error('secret rm requires a NAME');
  return { binary: 'wrangler', args: ['secret', 'delete', arg] };
}

export type DomainAction = 'add' | 'rm';

/** `airlock domain add HOSTNAME | rm HOSTNAME` */
export function buildDomain(
  config: AirlockConfig,
  action: DomainAction,
  hostname: string,
): CommandBuild {
  assertWorkers(config.project.target);
  if (!hostname) throw new Error('domain command requires a HOSTNAME');
  return {
    binary: 'wrangler',
    args: action === 'add' ? ['domains', 'add', hostname] : ['domains', 'remove', hostname],
  };
}
