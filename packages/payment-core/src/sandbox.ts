/**
 * Code-execution sandbox seam.
 *
 * A code-executing Harness (e.g. smolagents `CodeAgent` runs generated Python)
 * needs isolation when exposed publicly. This file is ONLY the boundary — the
 * default in v1 is the Harness's *own* restricted executor (e.g. smolagents'
 * in-process `LocalPythonExecutor`), which is fine for dev/trusted callers but
 * is NOT real isolation. Real isolation (E2B / remote exec / gVisor) is a
 * pluggable provider that drops in later without touching call sites — same
 * deferral posture as the `WalletProvider` seam (see crypto.ts, ADR-0006).
 *
 * STATUS (v1): {@link unavailableSandboxProvider} throws. Until a real provider
 * is wired, a publicly-exposed code-executing Agent is the Publisher's risk;
 * recommend non-code-executing Harnesses or wiring E2B for untrusted exposure.
 */

export interface SandboxResult {
  stdout: string;
  /** Return value / last expression, if the runtime produced one. */
  result?: unknown;
}

export interface SandboxProvider {
  /** Execute code in isolation and return its output. */
  run(code: string, opts?: { timeoutMs?: number }): Promise<SandboxResult>;
}

export class SandboxProviderUnavailableError extends Error {
  constructor() {
    super(
      'no real code-execution sandbox is wired: v1 relies on the Harness’s own ' +
        'restricted executor (not isolation). Plug in an E2B / remote-exec provider ' +
        'for untrusted public exposure.',
    );
    this.name = 'SandboxProviderUnavailableError';
  }
}

/** Placeholder for real isolation until a provider (E2B/remote) is wired. */
export const unavailableSandboxProvider: SandboxProvider = {
  run: () => Promise.reject(new SandboxProviderUnavailableError()),
};
