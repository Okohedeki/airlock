#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { runDoctor } from './commands/doctor.js';
import { runInit } from './commands/init.js';
import { runStatus } from './commands/status.js';

async function readPackageVersion(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(here, '..', 'package.json');
  const raw = await readFile(pkgPath, 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

async function main() {
  const version = await readPackageVersion();
  const program = new Command();

  program
    .name('airlock-deploy')
    .description('ngrok for AI agents — set up, validate, and inspect Agent deploy configs')
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
      if (result.recipePath) {
        console.log(`✓ wrote ${result.recipePath}`);
      }
      console.log('\nnext steps:');
      console.log('  1. Edit .airlock-deploy/config.toml — set payment.wallet to your address');
      console.log('  2. Run `airlock-deploy doctor` to validate');
      console.log('  3. Deploy with `wrangler deploy` (workers) or `fly deploy` (fly)');
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
      if (!report.ok) {
        process.exit(1);
      }
    });

  program
    .command('status')
    .description('Print the current project configuration')
    .action(async () => {
      try {
        const summary = await runStatus(process.cwd());
        console.log(JSON.stringify(summary, null, 2));
      } catch (err) {
        console.error(`error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
