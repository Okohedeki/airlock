import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { caddyAsset, verifyCaddyArchive } from './caddy.js';

describe('native gateway installation', () => {
  it('selects official release assets on the supported desktop platforms', () => {
    expect(caddyAsset('win32', 'x64').archive).toMatch(/windows_amd64.zip$/);
    expect(caddyAsset('darwin', 'arm64').archive).toMatch(/mac_arm64.tar.gz$/);
    expect(caddyAsset('linux', 'x64').archive).toMatch(/linux_amd64.tar.gz$/);
    expect(() => caddyAsset('aix', 'ppc64')).toThrow('supports Windows');
  });
  it('accepts only the exact artifact whose SHA-512 digest matches', () => {
    const bytes = Buffer.from('verified artifact');
    const digest = createHash('sha512').update(bytes).digest('hex');
    expect(() => verifyCaddyArchive(bytes, 'caddy.zip', `${digest}  caddy.zip\n`)).not.toThrow();
    expect(() => verifyCaddyArchive(Buffer.from('modified'), 'caddy.zip', `${digest}  caddy.zip`)).toThrow('could not be verified');
    expect(() => verifyCaddyArchive(bytes, 'caddy.zip', `${digest}  wrong.zip`)).toThrow('could not be verified');
    expect(() => verifyCaddyArchive(bytes, 'caddy.zip', 'bad  caddy.zip')).toThrow('could not be verified');
  });
});
