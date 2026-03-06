import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createWriteStream, existsSync } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { logger } from '../logger.ts';

type Platform = 'macos-arm64' | 'macos-x64' | 'win-x64' | 'linux-x64';

export interface GpuInfo {
  accel: 'none' | 'cuda-12.4' | 'cuda-13.1' | 'vulkan';
  name?: string;
}

interface AssetPatterns {
  main: string;
  cudart?: string;
}

const BINARY_NAME = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
const RELEASES_API = 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest';

let cachedGpu: GpuInfo | null = null;

/**
 * Detect GPU and select the best acceleration backend.
 * - NVIDIA on Windows: CUDA (13.1 or 12.4 based on driver), Vulkan fallback for old drivers
 * - NVIDIA on Linux: Vulkan (llama.cpp doesn't ship Linux CUDA builds)
 * - AMD/Intel on Windows or Linux: Vulkan (universal GPU backend)
 * - macOS: 'none' (Metal is built into the macOS binary)
 */
export function detectGpu(): GpuInfo {
  if (cachedGpu) return cachedGpu;

  if (process.platform === 'darwin') {
    cachedGpu = { accel: 'none' };
    return cachedGpu;
  }

  // Try NVIDIA first (nvidia-smi is available on both Windows and Linux)
  const nvidia = detectNvidia();
  if (nvidia) {
    if (process.platform === 'linux') {
      cachedGpu = { accel: 'vulkan', name: nvidia.name };
    } else {
      // Windows: use CUDA if driver is new enough, otherwise Vulkan
      if (nvidia.cudaVersion >= 13.1) {
        cachedGpu = { accel: 'cuda-13.1', name: nvidia.name };
      } else if (nvidia.cudaVersion >= 12.4) {
        cachedGpu = { accel: 'cuda-12.4', name: nvidia.name };
      } else {
        logger.warn(`[BinaryManager] NVIDIA CUDA driver ${nvidia.cudaVersion} < 12.4, using Vulkan`);
        cachedGpu = { accel: 'vulkan', name: nvidia.name };
      }
    }
  } else {
    // No NVIDIA — check for any other GPU (AMD, Intel)
    const gpuName = detectAnyGpu();
    cachedGpu = gpuName ? { accel: 'vulkan', name: gpuName } : { accel: 'none' };
  }

  if (cachedGpu.accel !== 'none') {
    logger.info(`[BinaryManager] Detected GPU: ${cachedGpu.name ?? 'unknown'} (${cachedGpu.accel})`);
  }

  return cachedGpu;
}

function detectNvidia(): { name?: string; cudaVersion: number } | null {
  try {
    const output = execFileSync('nvidia-smi', [], { encoding: 'utf-8', timeout: 10_000 });
    const cudaMatch = output.match(/CUDA Version:\s*([\d.]+)/);
    const cudaVersion = cudaMatch ? parseFloat(cudaMatch[1]!) : 0;

    let name: string | undefined;
    try {
      name = execFileSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], {
        encoding: 'utf-8', timeout: 5_000,
      }).trim().split('\n')[0];
    } catch { /* display name is optional */ }

    return { name, cudaVersion };
  } catch {
    return null;
  }
}

function detectAnyGpu(): string | null {
  try {
    if (process.platform === 'win32') {
      const output = execFileSync('powershell', ['-Command',
        'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name',
      ], { encoding: 'utf-8', timeout: 10_000 }).trim();

      // Filter out virtual/basic adapters that can't do GPU compute
      const gpus = output.split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.includes('Microsoft Basic') && !l.includes('Remote Desktop'));

      return gpus[0] || null;
    }

    if (process.platform === 'linux') {
      const output = execFileSync('lspci', [], { encoding: 'utf-8', timeout: 5_000 });
      const match = output.match(/(?:VGA|3D|Display).*?:\s*(.+)/i);
      return match ? match[1]!.trim() : null;
    }
  } catch { /* detection failed */ }
  return null;
}

function detectPlatform(): Platform {
  const arch = process.arch;
  const plat = process.platform;

  if (plat === 'darwin') return arch === 'arm64' ? 'macos-arm64' : 'macos-x64';
  if (plat === 'win32') return 'win-x64';
  if (plat === 'linux') return 'linux-x64';
  throw new Error(`Unsupported platform: ${plat}-${arch}`);
}

function getAssetPatterns(platform: Platform, gpu: GpuInfo): AssetPatterns {
  switch (platform) {
    case 'macos-arm64': return { main: 'bin-macos-arm64' };
    case 'macos-x64': return { main: 'bin-macos-x64' };
    case 'linux-x64': {
      if (gpu.accel === 'vulkan') return { main: 'bin-ubuntu-vulkan-x64' };
      return { main: 'bin-ubuntu-x64' };
    }
    case 'win-x64': {
      if (gpu.accel.startsWith('cuda')) {
        const ver = gpu.accel.replace('cuda-', '');
        return {
          main: `bin-win-cuda-${ver}-x64`,
          cudart: `cudart-llama-bin-win-cuda-${ver}-x64`,
        };
      }
      if (gpu.accel === 'vulkan') return { main: 'bin-win-vulkan-x64' };
      return { main: 'bin-win-cpu-x64' };
    }
  }
}

function getBinaryDirName(platform: Platform, gpu: GpuInfo): string {
  if (gpu.accel === 'none') return platform;
  switch (platform) {
    case 'win-x64': return `win-${gpu.accel}-x64`;
    case 'linux-x64': return `linux-${gpu.accel}-x64`;
    default: return platform;
  }
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

/**
 * Resolve the path to the llama-server binary.
 *
 * 1. Check if `llama-server` is on PATH (Docker / system install)
 * 2. Check if already downloaded to `<baseDir>/.llama-server/<platform>/`
 * 3. Download from GitHub releases (GPU-accelerated when NVIDIA/AMD/Intel GPU detected)
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
  const gpu = detectGpu();
  const dirName = getBinaryDirName(platform, gpu);
  const binDir = path.join(baseDir, '.llama-server', dirName);
  const binPath = path.join(binDir, BINARY_NAME);

  if (existsSync(binPath)) {
    return binPath;
  }

  // 3. Download
  await downloadBinary(binDir, platform, gpu);
  return binPath;
}

/**
 * Download an asset archive, extract it to a temp dir, and return the temp dir path.
 */
async function downloadAndExtract(destDir: string, asset: any): Promise<string> {
  logger.info(`[BinaryManager] Downloading ${asset.name}...`);

  await fs.mkdir(destDir, { recursive: true });
  const archivePath = path.join(destDir, asset.name);

  const dlRes = await fetch(asset.browser_download_url, { redirect: 'follow' });
  if (!dlRes.ok || !dlRes.body) throw new Error(`Download failed: ${dlRes.status}`);
  const nodeStream = Readable.fromWeb(dlRes.body as any);
  await pipeline(nodeStream, createWriteStream(archivePath));

  const extractDir = path.join(destDir, `_extract_${Date.now()}`);
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

  await fs.unlink(archivePath).catch(() => {});
  return extractDir;
}

/**
 * Copy all files from srcDir (non-recursive — same directory only) to destDir.
 */
async function copyDirFiles(srcDir: string, destDir: string): Promise<void> {
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    await fs.rename(src, dest).catch(async () => {
      await fs.copyFile(src, dest);
      await fs.unlink(src);
    });
  }
}

/**
 * Recursively copy all files from srcDir (flattening nested directories) to destDir.
 */
async function copyAllFiles(srcDir: string, destDir: string): Promise<void> {
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    if (entry.isDirectory()) {
      await copyAllFiles(src, destDir);
    } else if (entry.isFile()) {
      const dest = path.join(destDir, entry.name);
      await fs.rename(src, dest).catch(async () => {
        await fs.copyFile(src, dest);
        await fs.unlink(src);
      });
    }
  }
}

async function downloadBinary(destDir: string, platform: Platform, gpu: GpuInfo): Promise<void> {
  const res = await fetch(RELEASES_API);
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const release: any = await res.json();

  const patterns = getAssetPatterns(platform, gpu);

  // Find main binary asset (exclude cudart runtime packages)
  const mainAsset = release.assets?.find((a: any) =>
    a.name.includes(patterns.main) && !a.name.startsWith('cudart')
  );
  if (!mainAsset) throw new Error(`No llama-server binary found for platform: ${platform}`);

  // Download and extract main binary
  const mainExtractDir = await downloadAndExtract(destDir, mainAsset);
  const found = await findFileRecursive(mainExtractDir, BINARY_NAME);
  if (!found) throw new Error('llama-server binary not found in archive');
  await copyDirFiles(path.dirname(found), destDir);
  await fs.rm(mainExtractDir, { recursive: true, force: true });

  // Download CUDA runtime DLLs alongside the binary
  if (patterns.cudart) {
    const cudartAsset = release.assets?.find((a: any) => a.name.includes(patterns.cudart));
    if (cudartAsset) {
      const cudartExtractDir = await downloadAndExtract(destDir, cudartAsset);
      await copyAllFiles(cudartExtractDir, destDir);
      await fs.rm(cudartExtractDir, { recursive: true, force: true });
    } else {
      logger.warn('[BinaryManager] CUDA runtime package not found — GPU acceleration may not work');
    }
  }

  // Create short symlinks for versioned shared libs (e.g. libmtmd.0.0.8209.dylib -> libmtmd.0.dylib)
  const destEntries = await fs.readdir(destDir);
  for (const name of destEntries) {
    const match = name.match(/^(lib[\w-]+\.\d+)\.\d+\.\d+\.(dylib|so)$/);
    if (!match) continue;
    const shortName = `${match[1]}.${match[2]}`;
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

  logger.info(`[BinaryManager] llama-server ready at ${path.join(destDir, BINARY_NAME)}`);
}

// Exported for testing — not part of the public API
export { getAssetPatterns as _getAssetPatterns, getBinaryDirName as _getBinaryDirName };
export type { Platform as _Platform };
export function _resetGpuCache() { cachedGpu = null; }
