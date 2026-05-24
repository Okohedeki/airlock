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
import { NotLoggedInError, runWhoami } from './commands/whoami.js';
import { readConfig } from './config-file.js';
import {
  buildDelete,
  buildDeploy,
  buildDev,
  buildDomain,
  buildLogs,
  buildSecret,
  type DomainAction,
  inheritSpawner,
  installUrlFor,
  type SecretAction,
  TargetBinaryMissingError,
} from './exec.js';

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
    return await inheritSpawner(
      ...(Object.values(buildDev(port)).slice(0, 2) as [string, string[]]),
      process.cwd(),
    );
  } catch (err) {
    if (err instanceof TargetBinaryMissingError) {
      console.error(
        `error: \`cloudflared\` is not on your PATH. Install: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/`,
      );
      return 127;
    }
    throw err;
  }
}

async function main() {
  const version = await readPackageVersion();
  const program = new Command();

  program
    .name('airlock-deploy')
    .description('ngrok for AI agents — set up, validate, deploy, and inspect Agent projects')
    .version(version, '-v, --version');

  program
    .command('init')
    .description('Wrap the current project with an airlock-deploy config and a starter Recipe')
    .argument('<name>', 'project name (used in recipe configs)')
    .option('-t, --target <target>', 'deploy Target: workers | fly', 'fly')
    .option('--no-recipe', 'skip writing the Recipe config (wrangler.toml / fly.toml)')
    .action(async (name: string, opts: { target: string; recipe: boolean }) => {
      if (opts.target !== 'workers' && opts.target !== 'fly') {
        console.error(`error: --target must be "workers" or "fly", got "${opts.target}"`);
        process.exit(2);
      }
      const result = await runInit({
        cwd: process.cwd(),
        name,
        target: opts.target,
        scaffoldRecipe: opts.recipe,
      });
      console.log(`✓ wrote ${result.configPath}`);
      if (result.recipePath) console.log(`✓ wrote ${result.recipePath}`);
      console.log('\nnext steps:');
      console.log('  1. Edit .airlock-deploy/config.toml — set payment.wallet to your address');
      console.log('  2. Run `airlock-deploy doctor` to validate');
      console.log('  3. Deploy with `airlock-deploy deploy`');
    });

  program
    .command('doctor')
    .description('Validate the local airlock-deploy config and report issues')
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
    .description('Ship the Agent to the Target (wraps wrangler/fly deploy)')
    .action(async () => process.exit(await runWithConfig(buildDeploy)));

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
    .description('Set a secret (workers prompts, fly takes NAME=VALUE)')
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
    .description('Authenticate this CLI to an airlock-deploy backend via GitHub device flow')
    .option('--backend <url>', 'backend base URL', defaultBackend)
    .action(async (opts: { backend: string }) => {
      try {
        const result = await runLogin({ backend: opts.backend });
        console.log(`\n✓ logged in. token saved to ~/.airlock-deploy/auth.json`);
        console.log(`  backend: ${result.backend}`);
      } catch (err) {
        console.error(`error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  program
    .command('sync')
    .description('Register this project with the airlock-deploy backend so the dashboard shows it')
    .action(async () => {
      try {
        const result = await runSync({ cwd: process.cwd() });
        console.log(`✓ project synced: ${result.name} (id=${result.id}, target=${result.target})`);
      } catch (err) {
        if (err instanceof NotLoggedInError) {
          console.error('not logged in — run `airlock-deploy login`');
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
          console.error('not logged in — run `airlock-deploy login`');
          process.exit(1);
        }
        console.error(`error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

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
