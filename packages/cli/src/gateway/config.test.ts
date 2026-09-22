import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { desktopHostname, loadDesktopGateway, saveDesktopGateway } from './config.js';

describe('desktop address configuration', () => {
  it('normalizes a hostname and rejects config injection or non-domain addresses', () => {
    expect(desktopHostname(' HTTPS://Agents.Example.COM/ ')).toBe('agents.example.com');
    for (const input of ['', 'http://agents.example.com', '127.0.0.1', 'localhost', 'agent.local', 'agent.example.com:443', 'agent.example.com/path', 'agent.example.com\n{ admin 0.0.0.0:2019 }']) {
      expect(() => desktopHostname(input)).toThrow('Enter a public domain');
    }
  });
  it('remembers the desktop address without a project relay file', async () => {
    const home = await mkdtemp(join(tmpdir(), 'airlock-gateway-config-'));
    try {
      expect(await loadDesktopGateway(home)).toBeUndefined();
      await saveDesktopGateway('agents.example.com', home);
      expect(await loadDesktopGateway(home)).toEqual({ hostname: 'agents.example.com' });
      await saveDesktopGateway('other.example.com', home);
      expect(await loadDesktopGateway(home)).toEqual({ hostname: 'other.example.com' });
      await expect(saveDesktopGateway('bad', home)).rejects.toThrow();
      expect(JSON.parse(await readFile(join(home, 'desktop.json'), 'utf8'))).toEqual({ hostname: 'other.example.com' });
    } finally {
      if (!resolve(home).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe cleanup');
      await rm(home, { recursive: true, force: true });
    }
  });
});
