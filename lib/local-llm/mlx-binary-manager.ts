import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createWriteStream, existsSync } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { logger } from '../logger.ts';

const BINARY_NAME = 'mlx-serve';
const RELEASES_API = 'https://api.github.com/repos/ddalcu/mlx-serve/releases/latest';
const ASSET_PATTERN = 'mlx-serve-bin-macos-arm64';

let cachedMlxVersion: { baseDir: string; value: string | null } | null = null;
let cachedIsMlxSystem: boolean | null = null;

/**
 * Resolve the path to the mlx-serve binary.
 *
 * 1. Check if `mlx-serve` is on PATH (system install)
 * 2. Check if already downloaded to `<baseDir>/.mlx-serve/macos-arm64/`
 * 3. Download from GitHub releases (macOS ARM64 only)
 */
export async function getMlxBinaryPath(baseDir: string): Promise<string> {
  // 1. Check PATH
  try {
    const result = execFileSync('which', [BINARY_NAME], { encoding: 'utf-8' }).trim();
    if (result) {
      logger.info(`[MlxBinaryManager] Using system mlx-serve: ${result}`);
      return result;
    }
  } catch { /* not on PATH */ }

  // 2. Check local download
  const binDir = path.join(baseDir, '.mlx-serve', 'macos-arm64');
  const binPath = path.join(binDir, BINARY_NAME);

  if (existsSync(binPath)) {
    return binPath;
  }

  // 3. Download
  await downloadMlxBinary(binDir);
  return binPath;
}

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

async function downloadMlxBinary(destDir: string): Promise<void> {
  const res = await fetch(RELEASES_API);
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const release: any = await res.json();

  const asset = release.assets?.find((a: any) => a.name.includes(ASSET_PATTERN));
  if (!asset) throw new Error('No mlx-serve binary found for macOS ARM64');

  logger.info(`[MlxBinaryManager] Downloading ${asset.name}...`);

  await fs.mkdir(destDir, { recursive: true });
  const archivePath = path.join(destDir, asset.name);

  const dlRes = await fetch(asset.browser_download_url, { redirect: 'follow' });
  if (!dlRes.ok || !dlRes.body) throw new Error(`Download failed: ${dlRes.status}`);
  const nodeStream = Readable.fromWeb(dlRes.body as any);
  await pipeline(nodeStream, createWriteStream(archivePath));

  const extractDir = path.join(destDir, `_extract_${Date.now()}`);
  await fs.mkdir(extractDir, { recursive: true });

  logger.info(`[MlxBinaryManager] Extracting ${asset.name}...`);
  if (asset.name.endsWith('.tar.gz')) {
    execFileSync('tar', ['xzf', archivePath, '-C', extractDir]);
  } else if (asset.name.endsWith('.zip')) {
    execFileSync('unzip', ['-o', archivePath, '-d', extractDir]);
  }

  await fs.unlink(archivePath).catch(() => {});

  // Find the binary in the extracted directory and move everything to destDir
  const found = await findFileRecursive(extractDir, BINARY_NAME);
  if (!found) throw new Error('mlx-serve binary not found in archive');

  // Move all files and subdirectories (e.g. lib/) from the binary's directory to destDir
  const srcDir = path.dirname(found);
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    await fs.rename(src, dest).catch(async () => {
      await fs.cp(src, dest, { recursive: true });
      await fs.rm(src, { recursive: true, force: true });
    });
  }

  await fs.rm(extractDir, { recursive: true, force: true });

  // Make binaries and shared libs executable on Unix
  await chmodRecursive(destDir);

  logger.info(`[MlxBinaryManager] mlx-serve ready at ${path.join(destDir, BINARY_NAME)}`);
}

async function chmodRecursive(dir: string): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await chmodRecursive(fullPath);
    } else {
      await fs.chmod(fullPath, 0o755).catch(() => {});
    }
  }
}

/**
 * Get the version string from the local mlx-serve binary without triggering a download.
 */
export function getMlxBinaryVersion(baseDir: string): string | null {
  if (cachedMlxVersion && cachedMlxVersion.baseDir === baseDir) return cachedMlxVersion.value;

  function parseVersion(binPath: string): string | null {
    try {
      const result = spawnSync(binPath, ['--version'], { timeout: 5000, encoding: 'utf-8' });
      const output = (result.stdout || '') + '\n' + (result.stderr || '');
      // mlx-serve --version output: "mlx-serve 0.3.1" or just "0.3.1"
      const match = output.match(/(\d+\.\d+\.\d+)/);
      return match ? match[1]! : null;
    } catch {
      return null;
    }
  }

  let version: string | null = null;

  // Check system PATH first
  try {
    const sysPath = execFileSync('which', [BINARY_NAME], { encoding: 'utf-8', timeout: 3000 }).trim();
    if (sysPath) version = parseVersion(sysPath);
  } catch { /* not on PATH */ }

  if (version === null) {
    // Check local binary
    const binPath = path.join(baseDir, '.mlx-serve', 'macos-arm64', BINARY_NAME);
    if (existsSync(binPath)) {
      version = parseVersion(binPath);
    }
  }

  cachedMlxVersion = { baseDir, value: version };
  return version;
}

/**
 * Check if mlx-serve is a system install (on PATH) vs managed by us.
 */
export function isMlxSystemBinary(): boolean {
  if (cachedIsMlxSystem !== null) return cachedIsMlxSystem;
  try {
    execFileSync('which', [BINARY_NAME], { encoding: 'utf-8', timeout: 3000 });
    cachedIsMlxSystem = true;
  } catch {
    cachedIsMlxSystem = false;
  }
  return cachedIsMlxSystem;
}

export interface MlxUpdateInfo {
  available: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  latestTag: string | null;
  publishedAt: string | null;
}

/**
 * Compare local mlx-serve version with latest GitHub release.
 * Uses semver comparison (e.g., 0.3.0 vs 0.3.1).
 */
export async function checkForMlxUpdate(baseDir: string): Promise<MlxUpdateInfo> {
  const currentVersion = getMlxBinaryVersion(baseDir);

  try {
    const res = await fetch(RELEASES_API);
    if (!res.ok) return { available: false, currentVersion, latestVersion: null, latestTag: null, publishedAt: null };

    const release: any = await res.json();
    const tag = release.tag_name; // e.g., "v0.3.1"
    const latestVersion = tag?.replace(/^v/, '') || null;
    const publishedAt = release.published_at || null;

    const available = !!(currentVersion && latestVersion && compareSemver(latestVersion, currentVersion) > 0);

    return { available, currentVersion, latestVersion, latestTag: tag || null, publishedAt };
  } catch (err) {
    logger.warn('[MlxBinaryManager] Failed to check for updates:', err);
    return { available: false, currentVersion, latestVersion: null, latestTag: null, publishedAt: null };
  }
}

/**
 * Delete the current managed binary and re-download the latest release from GitHub.
 */
export async function updateMlxBinary(baseDir: string): Promise<void> {
  const binDir = path.join(baseDir, '.mlx-serve', 'macos-arm64');
  await fs.rm(binDir, { recursive: true, force: true });
  await downloadMlxBinary(binDir);
  // Invalidate caches
  cachedMlxVersion = null;
  cachedIsMlxSystem = null;
}

/**
 * Compare two semver strings. Returns >0 if a > b, <0 if a < b, 0 if equal.
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
