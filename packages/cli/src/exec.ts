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

// ---- Docker: the reproducible run path (epic 09, ADR-0012) ------------------

/** `docker build -t <image> [-f <dockerfile>] <context>` */
export function buildDockerBuild(
  image: string,
  contextDir: string,
  dockerfile?: string,
): CommandBuild {
  const args = ['build', '-t', image];
  if (dockerfile) args.push('-f', dockerfile);
  args.push(contextDir);
  return { binary: 'docker', args };
}

export interface DockerRunOptions {
  image: string;
  /** Host port mapped to the container's :3000. */
  port: number;
  name?: string;
  /** Host dir mounted at /app/worker/.airlock so the SQLite State Store persists. */
  stateDir?: string;
  /** Path passed to --env-file (secrets: API keys, HOOK_SECRET, …). */
  envFile?: string;
  /** Extra -e KEY=VALUE pairs. */
  env?: Record<string, string>;
  /** Add host.docker.internal:host-gateway so a host-run model resolves (epic 03/19). */
  addHostGateway?: boolean;
  /** Mount the project read-only at /app/worker for dev (no rebuild). */
  mountDir?: string;
  detach?: boolean;
}

/** `docker run` for a worker image — publishes the port, mounts the state volume,
 *  wires host networking + secrets. Pure + testable. */
export function buildDockerRun(o: DockerRunOptions): CommandBuild {
  const args = ['run'];
  args.push(o.detach ? '-d' : '--rm');
  if (o.name) args.push('--name', o.name);
  args.push('-p', `${o.port}:3000`, '-e', 'PORT=3000');
  if (o.stateDir) args.push('-v', `${o.stateDir}:/app/worker/.airlock`);
  if (o.mountDir) args.push('-v', `${o.mountDir}:/app/worker`, '-w', '/app/worker', '-e', 'PYTHONPATH=/app/worker');
  if (o.addHostGateway) args.push('--add-host', 'host.docker.internal:host-gateway');
  if (o.envFile) args.push('--env-file', o.envFile);
  for (const [k, v] of Object.entries(o.env ?? {})) args.push('-e', `${k}=${v}`);
  args.push(o.image);
  return { binary: 'docker', args };
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
