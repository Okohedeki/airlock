import { describe, expect, it } from 'vitest';
import { SandboxProviderUnavailableError, unavailableSandboxProvider } from './sandbox.js';

describe('unavailableSandboxProvider', () => {
  it('rejects until a real isolation provider is wired', async () => {
    await expect(unavailableSandboxProvider.run('print(1)')).rejects.toBeInstanceOf(
      SandboxProviderUnavailableError,
    );
  });
});
