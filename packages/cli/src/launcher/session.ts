import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runUp, type UpHandle } from '../commands/up.js';
import { managedAccess, type ManagedAccess } from '../managed-access.js';
import type { AgentChoice } from './catalog.js';
import { desktopHostname, type DesktopGateway } from '../gateway/config.js';

export function agentSession(agents: AgentChoice[], opts: {
  python?: string; port?: number; relay?: string;
  desktop?: DesktopGateway; desktopMode?: boolean;
  runImpl?: typeof runUp; accessImpl?: typeof managedAccess;
} = {}) {
  let handle: UpHandle | undefined;
  let access: ManagedAccess | undefined;
  let status = 'idle';
  let message = '';
  let active: { id: string; name: string; url: string; local: boolean } | null = null;
  let relay = opts.relay;
  let desktop = opts.desktop;
  let startup: Promise<void> = Promise.resolve();
  const port = opts.port ?? 3030;
  const profile = (agent: AgentChoice) => resolve(agent.directory, relay ?? '.airlock/relay.json');
  return {
    state: () => ({ status, message, active, agents: agents.map(({ directory, ...agent }) => ({
      ...agent, connected: !!desktop || (!opts.desktopMode && existsSync(profile({ ...agent, directory }))),
    })) }),
    configureDesktop: (hostname: string) => {
      if (status === 'starting' || handle) throw new Error('Stop the agent before changing its public address.');
      desktop = { hostname: desktopHostname(hostname) };
    },
    configure: (path: string) => {
      if (status === 'starting' || handle) throw new Error('Stop the agent before changing its connection.');
      if (!path || !existsSync(resolve(path))) throw new Error('Connection profile not found. Choose an existing relay.json file.');
      relay = resolve(path);
      desktop = undefined;
    },
    start: async (id: string, local: boolean) => {
      if (status === 'starting' || handle) throw new Error('An agent is already active. Stop it before starting another.');
      const agent = agents.find((item) => item.id === id);
      if (!agent) throw new Error('Choose an agent from this workspace.');
      if (!local && !desktop) {
        if (opts.desktopMode) throw new Error('Set up this desktop gateway to create your public link.');
        if (!existsSync(profile(agent))) throw new Error('Connect your relay once to create public links. Open Connection settings to continue.');
      }
      status = 'starting'; message = '';
      let finished!: () => void;
      startup = new Promise<void>(resolve => { finished = resolve; });
      try {
        access = await (opts.accessImpl ?? managedAccess)(agent.directory);
        handle = await (opts.runImpl ?? runUp)({
          cwd: agent.directory, python: opts.python ?? (process.platform === 'win32' ? 'python' : 'python3'),
          port, noTunnel: local, relay: profile(agent), access, desktop: local ? undefined : desktop,
        });
        const current = handle;
        active = { id, name: agent.name, url: handle.url ?? `http://127.0.0.1:${port}`, local };
        status = 'running';
        void handle.done.then(() => {
          if (handle !== current) return;
          handle = undefined; active = null; status = 'error';
          message = 'The agent stopped. Start it again when you are ready.';
        });
      } catch (error) {
        status = 'error'; message = (error as Error).message; access = undefined;
        throw error;
      } finally { finished(); }
    },
    stop: async () => {
      await startup;
      const current = handle;
      handle = undefined; active = null; status = 'idle'; message = ''; access = undefined;
      await current?.stop();
    },
    consoleLink: () => {
      if (!handle || !access) throw new Error('Start an agent first.');
      const fragment = new URLSearchParams({ operator: access.operator, caller: access.caller });
      return `http://127.0.0.1:${port}/console#${fragment}`;
    },
  };
}
