import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';

export interface AgentChoice { id: string; name: string; harness: string; directory: string; location: string }

/** Discover explicit agent manifests under the selected workspace, without following symlinks. */
export async function discoverAgents(root: string): Promise<AgentChoice[]> {
  const agents: AgentChoice[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    if (entries.some((entry) => entry.name === 'worker.yaml' && entry.isFile())) {
      try {
        const data = parse(await readFile(join(directory, 'worker.yaml'), 'utf8'));
        if (typeof data?.harness === 'string') agents.push({
          id: createHash('sha256').update(directory).digest('hex').slice(0, 16),
          name: String(data.worker?.name ?? relative(root, directory) ?? 'My agent'),
          harness: data.harness, directory, location: relative(root, directory) || '.',
        });
      } catch { /* Invalid manifests are not launchable choices. */ }
      return;
    }
    if (depth >= 3) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || ['node_modules', 'dist', '__pycache__'].includes(entry.name)) continue;
      await visit(join(directory, entry.name), depth + 1);
    }
  };
  await visit(root, 0);
  return agents.sort((a, b) => a.name.localeCompare(b.name));
}
