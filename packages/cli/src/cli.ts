#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { clearAuth } from './auth-store.js';
import { runDoctor } from './commands/doctor.js';
import { runInit } from './commands/init.js';
import { runLogin } from './commands/login.js';
import { runStatus } from './commands/status.js';
import { runSync } from './commands/sync.js';
import { runUp } from './commands/up.js';
import { NotLoggedInError, runWhoami } from './commands/whoami.js';
import { readConfig } from './config-file.js';
import { runMigrate } from './migrate.js';
import {
  buildDelete,
  buildDeploy,
  buildDomain,
  buildLogs,
  buildSecret,
  type DomainAction,
  inheritSpawner,
  installUrlFor,
  type SecretAction,
  TargetBinaryMissingError,
} from './exec.js';
import { AGENT_HARNESSES, type AgentHarness } from './templates/fly-agent.js';
import { startTunnel } from './tunnel.js';

async function readPackageVersion(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(here, '..', 'package.json');
  const raw = await readFile(pkgPath, 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

async function runWithConfig(
  buildFn: (cfg: Awaited<ReturnType<typeof readConfig>>) => { binary: string; args: string[] },
): Promise<number> {
  const cwd = process.cwd();
  const config = await readConfig(cwd);
  const { binary, args } = buildFn(config);
  try {
    return await inheritSpawner(binary, args, cwd);
  } catch (err) {
    if (err instanceof TargetBinaryMissingError) {
      console.error(
        `error: \`${err.binary}\` is not on your PATH. Install it: ${installUrlFor(config.project.target)}`,
      );
      return 127;
    }
    throw err;
  }
}

async function runDev(port: number): Promise<number> {
  try {
    const tunnel = await startTunnel(port);
    console.log(`✓ public tunnel  →  ${tunnel.url}`);
    console.log(`  forwarding to  http://localhost:${port}`);
    console.log('  press Ctrl-C to close');
    await new Promise<void>((resolve) => {
      process.on('SIGINT', () => {
        tunnel.stop();
        resolve();
      });
    });
    return 0;
  } catch (err) {
    console.error(`error: tunnel failed — ${(err as Error).message}`);
    return 1;
  }
}

async function main() {
  const version = await readPackageVersion();
  const program = new Command();

  program
    .name('airlock')
    .description('ngrok for AI agents — set up, validate, deploy, and inspect Agent projects')
    .version(version, '-v, --version');

  program
    .command('init')
    .description('Wrap the current project with an airlock config and a starter Recipe')
    .argument('<name>', 'project name (used in recipe configs)')
    .option('-t, --target <target>', 'deploy Target: workers | fly', 'fly')
    .option('--no-recipe', 'skip writing the Recipe config (wrangler.toml / fly.toml)')
    .option(
      '--agent <harness>',
      'scaffold a harness-backed agentic service: smolagents | langgraph | crewai (Fly-only)',
    )
    .option(
      '--detect',
      'scan THIS repo, detect the harness + entrypoint, and wire it via [agent] (Fly-only)',
    )
    .option('--self-host', 'self-host on your own hardware (run via `airlock up`; no cloud Recipe)')
    .action(
      async (
        name: string,
        opts: {
          target: string;
          recipe: boolean;
          agent?: string;
          detect?: boolean;
          selfHost?: boolean;
        },
      ) => {
        if (opts.target !== 'workers' && opts.target !== 'fly') {
          console.error(`error: --target must be "workers" or "fly", got "${opts.target}"`);
          process.exit(2);
        }
        if (opts.agent && !AGENT_HARNESSES.includes(opts.agent as AgentHarness)) {
          console.error(`error: --agent must be one of ${AGENT_HARNESSES.join(' | ')}`);
          process.exit(2);
        }
        if (opts.agent && opts.target !== 'fly') {
          console.error(
            `error: --agent=${opts.agent} requires --target=fly (Python harnesses run on Fly)`,
          );
          process.exit(2);
        }
        if (opts.detect && opts.target !== 'fly') {
          console.error('error: --detect requires --target=fly (Python harnesses run on Fly)');
          process.exit(2);
        }
        const result = await runInit({
          cwd: process.cwd(),
          name,
          target: opts.target,
          scaffoldRecipe: opts.recipe,
          harness: opts.agent as AgentHarness | undefined,
          detect: opts.detect,
          mode: opts.selfHost ? 'self-hosted' : undefined,
        });
        console.log(`✓ wrote ${result.configPath}`);
        if (result.recipePath) console.log(`✓ wrote ${result.recipePath}`);
        for (const p of result.agentPaths ?? []) console.log(`✓ wrote ${p}`);
        for (const p of result.detectPaths ?? []) console.log(`✓ wrote ${p}`);
        if (result.detected) {
          console.log('\ndetected (confirm or edit .airlock/config.toml [agent]):');
          for (const line of result.detected.evidence) console.log(`  • ${line}`);
          console.log('\nnext steps:');
          console.log('  1. Confirm [agent] harness + entrypoint in .airlock/config.toml');
          console.log('  2. `pip install -r requirements.txt`');
          if (opts.selfHost) {
            console.log('  3. `airlock up` — run the agent here + front it with a public URL');
          } else {
            console.log('  3. `python -m airlock_agent` to run locally, then `airlock deploy`');
          }
          return;
        }
        console.log('\nnext steps:');
        if (opts.agent) {
          console.log('  1. `pip install -r requirements.txt`');
          console.log(`  2. Edit adapter.py — run your harness (see examples/${opts.agent}-agent)`);
          console.log(
            '  3. Point the model: OPENAI_API_BASE / OPENAI_API_KEY (airlock secret set …)',
          );
          console.log('  4. `airlock doctor`, then `airlock deploy`');
        } else {
          console.log('  1. Run `airlock doctor` to validate');
          console.log('  2. Deploy with `airlock deploy`');
        }
      },
    );

  program
    .command('migrate')
    .description('Scaffold a worker.yaml from a legacy .airlock/config.toml')
    .option('-o, --out <file>', 'output filename', 'worker.yaml')
    .action(async (opts: { out: string }) => {
      try {
        const result = await runMigrate({ cwd: process.cwd(), out: opts.out });
        console.log(`✓ wrote ${result.workerPath}`);
        console.log('  review the TODO blocks — the full worker.yaml schema lands in epic 07');
      } catch (err) {
        console.error(`error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  program
    .command('build')
    .description('Build a reproducible Docker image for this worker.yaml (validates first)')
    .option('--base <image>', 'base image to layer on', undefined)
    .option('--no-base-build', "don't build the base image even if it's missing locally")
    .action(async (opts: { base?: string; baseBuild: boolean }) => {
      try {
        const { runBuild } = await import('./commands/build.js');
        await runBuild({ cwd: process.cwd(), base: opts.base, noBaseBuild: opts.baseBuild === false });
      } catch (err) {
        console.error(`error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  program
    .command('doctor')
    .description('Validate the local airlock config and report issues')
    .action(async () => {
      const report = await runDoctor(process.cwd());
      for (const f of report.findings) {
        const icon = f.level === 'ok' ? '✓' : f.level === 'warn' ? '!' : '✗';
        console.log(`${icon} ${f.message}`);
      }
      if (!report.ok) process.exit(1);
    });

  program
    .command('status')
    .description('Print the current project configuration')
    .action(async () => {
      try {
        console.log(JSON.stringify(await runStatus(process.cwd()), null, 2));
      } catch (err) {
        console.error(`error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  program
    .command('deploy')
    .description('Deploy a multi-container fleet: N worker containers behind the router')
    .option('-r, --replicas <n>', 'number of worker replicas', '2')
    .option('-p, --port <port>', 'router (public) port', '8080')
    .option('--canary <image@pct>', 'add a canary version at pct% of new sessions')
    .option('--expose', 'open a public tunnel at the router')
    .option('--no-build', 'use the already-built image (skip docker build)')
    .action(async (opts: { replicas: string; port: string; canary?: string; expose?: boolean; build: boolean }) => {
      const { runDeploy } = await import('./commands/deploy.js');
      try {
        const handle = await runDeploy({
          cwd: process.cwd(),
          replicas: Number.parseInt(opts.replicas, 10),
          port: Number.parseInt(opts.port, 10),
          canary: opts.canary,
          expose: opts.expose,
          noBuild: opts.build === false,
        });
        const shutdown = async () => { await handle.stop(); process.exit(0); };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
        console.log('  press Ctrl-C to tear down the fleet');
        await new Promise(() => {});
      } catch (err) {
        console.error(`error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  const control = async (port: string, path: string, body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}/_control/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
    });
    console.log(JSON.stringify(await res.json()));
  };

  program
    .command('promote')
    .description('Promote a version to 100% of traffic (epic 08)')
    .requiredOption('--version <ver>', 'the version to promote')
    .option('-p, --port <port>', 'router control port', '8080')
    .action(async (opts: { version: string; port: string }) => control(opts.port, 'promote', { version: opts.version }));

  program
    .command('rollback')
    .description('Instantly drop the canary; stable wins (epic 08)')
    .option('-p, --port <port>', 'router control port', '8080')
    .action(async (opts: { port: string }) => control(opts.port, 'rollback', {}));

  program
    .command('delete')
    .description('Tear down the deployment at the Target')
    .action(async () => process.exit(await runWithConfig(buildDelete)));

  program
    .command('logs')
    .description('Stream live logs from the deployment')
    .action(async () => process.exit(await runWithConfig(buildLogs)));

  const secret = program.command('secret').description('Manage secrets on the Target');
  secret
    .command('set <name=value>')
    .description('Set a secret (wrangler prompts for the value via stdin)')
    .action(async (arg: string) =>
      process.exit(await runWithConfig((c) => buildSecret(c, 'set' as SecretAction, arg))),
    );
  secret
    .command('list')
    .description('List secrets on the Target')
    .action(async () =>
      process.exit(await runWithConfig((c) => buildSecret(c, 'list' as SecretAction))),
    );
  secret
    .command('rm <name>')
    .description('Remove a secret')
    .action(async (arg: string) =>
      process.exit(await runWithConfig((c) => buildSecret(c, 'rm' as SecretAction, arg))),
    );

  const domain = program.command('domain').description('Manage custom domains on the Target');
  domain
    .command('add <hostname>')
    .description('Attach a custom domain')
    .action(async (hostname: string) =>
      process.exit(await runWithConfig((c) => buildDomain(c, 'add' as DomainAction, hostname))),
    );
  domain
    .command('rm <hostname>')
    .description('Detach a custom domain')
    .action(async (hostname: string) =>
      process.exit(await runWithConfig((c) => buildDomain(c, 'rm' as DomainAction, hostname))),
    );

  const defaultBackend = process.env.AIRLOCK_DEPLOY_BACKEND ?? 'http://localhost:8787';

  program
    .command('login')
    .description('Authenticate this CLI to an airlock backend via GitHub device flow')
    .option('--backend <url>', 'backend base URL', defaultBackend)
    .action(async (opts: { backend: string }) => {
      try {
        const result = await runLogin({ backend: opts.backend });
        console.log(`\n✓ logged in. token saved to ~/.airlock/auth.json`);
        console.log(`  backend: ${result.backend}`);
      } catch (err) {
        console.error(`error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  program
    .command('sync')
    .description('Register this project with the airlock backend so the dashboard shows it')
    .action(async () => {
      try {
        const result = await runSync({ cwd: process.cwd() });
        console.log(`✓ project synced: ${result.name} (id=${result.id}, target=${result.target})`);
      } catch (err) {
        if (err instanceof NotLoggedInError) {
          console.error('not logged in — run `airlock login`');
          process.exit(1);
        }
        console.error(`error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  program
    .command('logout')
    .description('Forget the stored CLI auth token')
    .action(async () => {
      await clearAuth();
      console.log('✓ logged out');
    });

  program
    .command('whoami')
    .description('Print the GitHub account this CLI is logged in as')
    .action(async () => {
      try {
        const me = await runWhoami();
        console.log(`${me.github_login} (id=${me.github_id})`);
      } catch (err) {
        if (err instanceof NotLoggedInError) {
          console.error('not logged in — run `airlock login`');
          process.exit(1);
        }
        console.error(`error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  program
    .command('up')
    .description('Self-host: run your config-bound agent here + front it with a public URL')
    .option('-p, --port <port>', 'port the agent listens on', '3000')
    .option('--python <bin>', 'python executable for `-m airlock_agent` (respects an active venv)')
    .option('--no-tunnel', 'run the agent locally without opening a public tunnel')
    .option(
      '--durable',
      'use a stable named tunnel on YOUR Cloudflare account (needs AIRLOCK_CF_TUNNEL_TOKEN + [tunnel].hostname; see docs/durable-hosting.md)',
    )
    .option('--max-concurrency <n>', 'max agent runs in flight before callers queue')
    .option('--max-queue <n>', 'max callers waiting beyond the running set before 429')
    .option('--queue-timeout <s>', 'seconds a caller waits in the queue before 429')
    .option(
      '--no-build-per-call',
      'reuse one shared agent object instead of rebuilding per request',
    )
    .option('--cf-protocol <proto>', 'cloudflared edge protocol: quic | http2 | auto')
    .option('--cf-region <region>', 'pin the cloudflared connector to a Cloudflare region (e.g. us)')
    .option('--cf-metrics <addr>', "expose cloudflared's metrics server on host:port")
    .option('--docker', 'run the Worker in Docker (reproducible; needs `airlock build` first)')
    .option('--image <ref>', 'image to run with --docker (default: the image from `airlock build`)')
    .option('--mount', 'dev: mount the project into the base image instead of a built image')
    .option('--env-file <path>', 'pass an env file to the container (--docker)')
    .option('--profile <name>', 'run a worker.yaml variant/profile (e.g. internal | external)')
    .option('--hostname <host>', 'durable-tunnel hostname (with --durable + AIRLOCK_CF_TUNNEL_TOKEN)')
    .action(
      async (opts: {
        port: string;
        python?: string;
        tunnel: boolean;
        durable?: boolean;
        maxConcurrency?: string;
        maxQueue?: string;
        queueTimeout?: string;
        buildPerCall: boolean;
        cfProtocol?: 'quic' | 'http2' | 'auto';
        cfRegion?: string;
        cfMetrics?: string;
        docker?: boolean;
        image?: string;
        mount?: boolean;
        envFile?: string;
        profile?: string;
        hostname?: string;
      }) => {
        const port = Number.parseInt(opts.port, 10);
        if (!Number.isFinite(port) || port <= 0) {
          console.error(`error: invalid --port "${opts.port}"`);
          process.exit(2);
        }
        const numOpt = (raw: string | undefined, flag: string): number | undefined => {
          if (raw === undefined) return undefined;
          const n = Number(raw);
          if (!Number.isFinite(n) || n < 0) {
            console.error(`error: invalid ${flag} "${raw}"`);
            process.exit(2);
          }
          return n;
        };
        try {
          const handle = await runUp({
            cwd: process.cwd(),
            port,
            python: opts.python,
            noTunnel: !opts.tunnel,
            durable: opts.durable,
            maxConcurrency: numOpt(opts.maxConcurrency, '--max-concurrency'),
            maxQueue: numOpt(opts.maxQueue, '--max-queue'),
            queueTimeout: numOpt(opts.queueTimeout, '--queue-timeout'),
            // commander sets buildPerCall=false only when --no-build-per-call is passed
            buildPerCall: opts.buildPerCall === false ? false : undefined,
            cfProtocol: opts.cfProtocol,
            cfRegion: opts.cfRegion,
            cfMetrics: opts.cfMetrics,
            docker: opts.docker,
            image: opts.image,
            mount: opts.mount,
            envFile: opts.envFile,
            profile: opts.profile,
            hostname: opts.hostname,
          });
          const shutdown = async () => {
            await handle.stop();
            process.exit(0);
          };
          process.on('SIGINT', shutdown);
          process.on('SIGTERM', shutdown);
          process.exit(await handle.done);
        } catch (err) {
          console.error(`error: ${(err as Error).message}`);
          process.exit(1);
        }
      },
    );

  program
    .command('dev')
    .description('Open a public Tunnel to your local Agent via cloudflared')
    .option('-p, --port <port>', 'local port the Agent is listening on', '3000')
    .action(async (opts: { port: string }) => {
      const port = Number.parseInt(opts.port, 10);
      if (!Number.isFinite(port) || port <= 0) {
        console.error(`error: invalid --port "${opts.port}"`);
        process.exit(2);
      }
      process.exit(await runDev(port));
    });

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
