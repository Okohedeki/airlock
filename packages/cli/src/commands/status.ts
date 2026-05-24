import { readConfig, validatePayment } from '../config-file.js';

export interface StatusSummary {
  project: { name: string; target: string };
  payment:
    | { configured: false }
    | {
        configured: true;
        enabled: boolean;
        mode: string;
        network: string;
        wallet: string;
      };
}

export async function runStatus(cwd: string): Promise<StatusSummary> {
  const config = await readConfig(cwd);
  const summary: StatusSummary = {
    project: { name: config.project.name, target: config.project.target },
    payment: { configured: false },
  };
  if (config.payment) {
    try {
      const parsed = validatePayment(config);
      if (parsed) {
        summary.payment = {
          configured: true,
          enabled: parsed.enabled,
          mode: parsed.mode,
          network: parsed.network,
          wallet: parsed.wallet,
        };
      }
    } catch {
      summary.payment = { configured: false };
    }
  }
  return summary;
}
