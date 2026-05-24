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

/** Map a Target to the publisher's CLI binary name. */
export function targetBinary(target: Target): string {
  switch (target) {
    case 'workers':
      return 'wrangler';
    case 'fly':
      return 'fly';
  }
}

/** Install-hint URL printed when the target binary is missing. */
export function installUrlFor(target: Target): string {
  return target === 'workers'
    ? 'https://developers.cloudflare.com/workers/wrangler/install-and-update/'
    : 'https://fly.io/docs/flyctl/install/';
}

export interface CommandBuild {
  binary: string;
  args: string[];
}

/** `airlock-deploy deploy` — pushes the project to its Target. */
export function buildDeploy(config: AirlockConfig): CommandBuild {
  const target = config.project.target;
  if (target === 'workers') return { binary: 'wrangler', args: ['deploy'] };
  return { binary: 'fly', args: ['deploy', '--app', config.project.name] };
}

/** `airlock-deploy delete` — tears down the deployment. */
export function buildDelete(config: AirlockConfig): CommandBuild {
  const target = config.project.target;
  if (target === 'workers') return { binary: 'wrangler', args: ['delete'] };
  return { binary: 'fly', args: ['apps', 'destroy', config.project.name, '--yes'] };
}

/** `airlock-deploy logs` — stream live logs from the deployment. */
export function buildLogs(config: AirlockConfig): CommandBuild {
  const target = config.project.target;
  if (target === 'workers') return { binary: 'wrangler', args: ['tail'] };
  return { binary: 'fly', args: ['logs', '--app', config.project.name] };
}

export type SecretAction = 'set' | 'list' | 'rm';

/** `airlock-deploy secret set NAME=value | list | rm NAME` */
export function buildSecret(
  config: AirlockConfig,
  action: SecretAction,
  arg?: string,
): CommandBuild {
  const target = config.project.target;
  if (target === 'workers') {
    if (action === 'set') {
      const name = (arg ?? '').split('=', 1)[0];
      if (!name) throw new Error('secret set requires NAME=VALUE');
      return { binary: 'wrangler', args: ['secret', 'put', name] };
    }
    if (action === 'list') return { binary: 'wrangler', args: ['secret', 'list'] };
    if (action === 'rm') {
      if (!arg) throw new Error('secret rm requires a NAME');
      return { binary: 'wrangler', args: ['secret', 'delete', arg] };
    }
  }
  // fly
  if (action === 'set') {
    if (!arg?.includes('=')) throw new Error('secret set requires NAME=VALUE');
    return { binary: 'fly', args: ['secrets', 'set', arg, '--app', config.project.name] };
  }
  if (action === 'list') {
    return { binary: 'fly', args: ['secrets', 'list', '--app', config.project.name] };
  }
  if (!arg) throw new Error('secret rm requires a NAME');
  return { binary: 'fly', args: ['secrets', 'unset', arg, '--app', config.project.name] };
}

export type DomainAction = 'add' | 'rm';

/** `airlock-deploy domain add HOSTNAME | rm HOSTNAME` */
export function buildDomain(
  config: AirlockConfig,
  action: DomainAction,
  hostname: string,
): CommandBuild {
  if (!hostname) throw new Error('domain command requires a HOSTNAME');
  const target = config.project.target;
  if (target === 'workers') {
    return {
      binary: 'wrangler',
      args: action === 'add' ? ['domains', 'add', hostname] : ['domains', 'remove', hostname],
    };
  }
  return {
    binary: 'fly',
    args:
      action === 'add'
        ? ['certs', 'add', hostname, '--app', config.project.name]
        : ['certs', 'remove', hostname, '--app', config.project.name],
  };
}

/**
 * `airlock-deploy dev` — open a public Tunnel to localhost:PORT via cloudflared.
 * The Publisher's local agent must already be listening on PORT.
 */
export function buildDev(port: number): CommandBuild {
  return {
    binary: 'cloudflared',
    args: ['tunnel', '--url', `http://localhost:${port}`],
  };
}
