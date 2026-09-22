import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { gatewayHome } from './config.js';

export const CADDY_VERSION = '2.11.4';
const execute = promisify(execFile);

export function caddyAsset(platform = process.platform, arch = process.arch) {
  const os = { win32: 'windows', darwin: 'mac', linux: 'linux' }[platform as string];
  const cpu = { x64: 'amd64', arm64: 'arm64' }[arch as string];
  if (!os || !cpu) throw new Error('Automatic gateway installation supports Windows, macOS and Linux on x64 or ARM64.');
  const binary = platform === 'win32' ? 'caddy.exe' : 'caddy';
  return { binary, archive: `caddy_${CADDY_VERSION}_${os}_${cpu}.${platform === 'win32' ? 'zip' : 'tar.gz'}` };
}

export function caddyPath(home = gatewayHome()) {
  return join(home, 'bin', `caddy-${CADDY_VERSION}`, caddyAsset().binary);
}

export async function caddyInstalled(home = gatewayHome()): Promise<boolean> {
  try { await access(caddyPath(home)); return true; } catch { return false; }
}

export function verifyCaddyArchive(bytes: Buffer, filename: string, checksums: string): void {
  const checksum = checksums.split(/\r?\n/).map(line => line.trim().split(/\s+/))
    .find(parts => parts[1]?.replace(/^\*/, '') === filename)?.[0];
  if (!checksum || !/^[a-f0-9]{128}$/i.test(checksum) || createHash('sha512').update(bytes).digest('hex') !== checksum.toLowerCase()) {
    throw new Error('The Caddy download could not be verified. Nothing was installed. Try again.');
  }
}

/** Download only pinned official release artifacts and verify before extraction or execution. */
export async function installCaddy(home = gatewayHome()): Promise<string> {
  if (await caddyInstalled(home)) return caddyPath(home);
  const asset = caddyAsset();
  const base = `https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/`;
  const download = async (filename: string, maximum: number) => {
    const response = await fetch(base + filename, { signal: AbortSignal.timeout(90_000) });
    if (!response.ok || Number(response.headers.get('content-length')) > maximum) throw new Error('Caddy could not be downloaded. Check your internet connection and try again.');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body!) {
      size += chunk.length;
      if (size > maximum) throw new Error('The gateway download exceeded its expected size.');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  };
  await mkdir(join(home, 'bin'), { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(home, 'bin', 'download-'));
  try {
    const checksums = await download(`caddy_${CADDY_VERSION}_checksums.txt`, 100_000);
    const archive = await download(asset.archive, 128 * 1024 * 1024);
    verifyCaddyArchive(archive, asset.archive, checksums.toString('utf8'));
    const archivePath = join(temporary, asset.archive);
    await writeFile(archivePath, archive);
    if (process.platform === 'win32') {
      // Paths travel through environment variables, never through interpolated shell code.
      await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Expand-Archive -LiteralPath $env:AIRLOCK_ARCHIVE -DestinationPath $env:AIRLOCK_EXTRACT'], {
        windowsHide: true, timeout: 60_000,
        env: { ...process.env, AIRLOCK_ARCHIVE: archivePath, AIRLOCK_EXTRACT: temporary },
      });
    } else {
      await execute('tar', ['-xzf', archivePath, '-C', temporary, asset.binary], { timeout: 60_000 });
      await chmod(join(temporary, asset.binary), 0o700);
    }
    const extracted = join(temporary, asset.binary);
    await readFile(extracted); // Missing or quarantined binaries must not be recorded as installed.
    const { stdout } = await execute(extracted, ['version'], { windowsHide: true, timeout: 10_000 });
    if (!stdout.startsWith(`v${CADDY_VERSION} `)) throw new Error('The downloaded gateway version was unexpected.');
    const destination = caddyPath(home);
    await mkdir(join(home, 'bin', `caddy-${CADDY_VERSION}`), { recursive: true });
    await rename(extracted, destination);
    return destination;
  } finally {
    if (!resolve(temporary).startsWith(resolve(home, 'bin') + sep)) throw new Error('Invalid installer cleanup path.');
    await rm(temporary, { recursive: true, force: true });
  }
}
