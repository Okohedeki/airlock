import { readConfig } from '../config-file.js';

export interface StatusSummary {
  project: { name: string; target: string };
}

export async function runStatus(cwd: string): Promise<StatusSummary> {
  const config = await readConfig(cwd);
  return {
    project: { name: config.project.name, target: config.project.target },
  };
}
