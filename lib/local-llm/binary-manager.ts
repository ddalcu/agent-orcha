import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createWriteStream, existsSync } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { logger } from '../logger.ts';

type Platform = 'macos-arm64' | 'macos-x64' | 'win-x64' | 'linux-x64';

const BINARY_NAME = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
const RELEASES_API = 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest';

function detectPlatform(): Platform {
  const arch = process.arch;
  const plat = process.platform;

  if (plat === 'darwin') return arch === 'arm64' ? 'macos-arm64' : 'macos-x64';
  if (plat === 'win32') return 'win-x64';
  if (plat === 'linux') return 'linux-x64';
  throw new Error(`Unsupported platform: ${plat}-${arch}`);
}

function getAssetPattern(platform: Platform): string {
  switch (platform) {
    case 'macos-arm64': return 'bin-macos-arm64';
    case 'macos-x64': return 'bin-macos-x64';
    case 'win-x64': return 'bin-win-cpu-x64';
    case 'linux-x64': return 'bin-ubuntu-x64';
  }
}

/**
 * Find a file by name recursively in a directory.
 */
async function findFileRecursive(dir: string, name: string): Promise<string | null> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return fullPath;
    if (entry.isDirectory()) {
      const found = await findFileRecursive(fullPath, name);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Resolve the path to the llama-server binary.
 *
 * 1. Check if `llama-server` is on PATH (Docker / system install)
 * 2. Check if already downloaded to `<baseDir>/.llama-server/<platform>/`
 * 3. Download from GitHub releases
 */
export async function getBinaryPath(baseDir: string): Promise<string> {
  // 1. Check PATH
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const result = execFileSync(cmd, ['llama-server'], { encoding: 'utf-8' }).trim();
    if (result) {
      logger.info(`[BinaryManager] Using system llama-server: ${result.split('\n')[0]}`);
      return result.split('\n')[0]!;
    }
  } catch { /* not on PATH */ }

  // 2. Check local download
  const platform = detectPlatform();
  const binDir = path.join(baseDir, '.llama-server', platform);
  const binPath = path.join(binDir, BINARY_NAME);

  if (existsSync(binPath)) {
    return binPath;
  }

  // 3. Download
  await downloadBinary(binDir, platform);
  return binPath;
}

async function downloadBinary(destDir: string, platform: Platform): Promise<void> {
  const res = await fetch(RELEASES_API);
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const release: any = await res.json();

  const pattern = getAssetPattern(platform);
  const asset = release.assets?.find((a: any) => a.name.includes(pattern));
  if (!asset) throw new Error(`No llama-server binary found for platform: ${platform}`);

  logger.info(`[BinaryManager] Downloading ${asset.name} (${release.tag_name})...`);

  await fs.mkdir(destDir, { recursive: true });
  const archivePath = path.join(destDir, asset.name);

  // Download archive
  const dlRes = await fetch(asset.browser_download_url, { redirect: 'follow' });
  if (!dlRes.ok || !dlRes.body) throw new Error(`Download failed: ${dlRes.status}`);
  const nodeStream = Readable.fromWeb(dlRes.body as any);
  await pipeline(nodeStream, createWriteStream(archivePath));

  // Extract to temp directory
  const extractDir = path.join(destDir, '_extract');
  await fs.mkdir(extractDir, { recursive: true });

  logger.info(`[BinaryManager] Extracting ${asset.name}...`);
  if (asset.name.endsWith('.tar.gz')) {
    execFileSync('tar', ['xzf', archivePath, '-C', extractDir]);
  } else if (asset.name.endsWith('.zip')) {
    if (process.platform === 'win32') {
      execFileSync('powershell', ['-Command', `Expand-Archive -Path "${archivePath}" -DestinationPath "${extractDir}" -Force`]);
    } else {
      execFileSync('unzip', ['-o', archivePath, '-d', extractDir]);
    }
  }

  // Find llama-server and move all sibling files (shared libs etc.) to destDir
  const found = await findFileRecursive(extractDir, BINARY_NAME);
  if (!found) throw new Error('llama-server binary not found in archive');

  const binSourceDir = path.dirname(found);
  const entries = await fs.readdir(binSourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const src = path.join(binSourceDir, entry.name);
    const dest = path.join(destDir, entry.name);
    await fs.rename(src, dest).catch(async () => {
      // rename fails across devices — fallback to copy+delete
      await fs.copyFile(src, dest);
      await fs.unlink(src);
    });
  }

  // Create short symlinks for versioned shared libs (e.g. libmtmd.0.0.8209.dylib -> libmtmd.0.dylib)
  // The tar.gz doesn't preserve symlinks, and the binary expects the short names via @rpath.
  const destEntries = await fs.readdir(destDir);
  for (const name of destEntries) {
    // Match patterns like libFoo.0.0.8209.dylib or libggml-cpu.0.9.7.dylib
    const match = name.match(/^(lib[\w-]+\.\d+)\.\d+\.\d+\.(dylib|so)$/);
    if (!match) continue;
    const shortName = `${match[1]}.${match[2]}`; // e.g. libmtmd.0.dylib
    if (shortName === name) continue;
    const linkPath = path.join(destDir, shortName);
    if (!existsSync(linkPath)) {
      await fs.symlink(name, linkPath);
    }
  }

  // Make binaries and shared libs executable on Unix
  if (process.platform !== 'win32') {
    for (const name of destEntries) {
      if (name.startsWith('_') || name.startsWith('.')) continue;
      await fs.chmod(path.join(destDir, name), 0o755).catch(() => {});
    }
  }

  // Clean up
  await fs.rm(extractDir, { recursive: true, force: true });
  await fs.unlink(archivePath).catch(() => {});

  logger.info(`[BinaryManager] llama-server ready at ${path.join(destDir, BINARY_NAME)}`);
}
