import { execFileSync } from '../utils/child-process.ts';
import { existsSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../logger.ts';
import {
  detectGpu,
  detectPlatform,
  downloadAndExtract,
  findFileRecursive,
  copyAllFiles,
} from '../local-llm/binary-manager.ts';

const BINARY_NAME = process.platform === 'win32' ? 'sd-cli.exe' : 'sd-cli';
const RELEASES_API = 'https://api.github.com/repos/leejet/stable-diffusion.cpp/releases/latest';

function getAssetPattern(): string {
  const platform = detectPlatform();
  const gpu = detectGpu();

  switch (platform) {
    case 'macos-arm64':
      return 'bin-Darwin-macOS';
    case 'macos-x64':
      return 'bin-Darwin-macOS';
    case 'linux-x64':
      if (gpu.accel === 'vulkan') return 'bin-Linux-Ubuntu';
      return 'bin-Linux-Ubuntu';
    case 'linux-arm64':
      return 'bin-Linux';
    case 'win-x64': {
      if (gpu.accel.startsWith('cuda')) return 'bin-win-cuda12-x64';
      if (gpu.accel === 'vulkan') return 'bin-win-vulkan-x64';
      return 'bin-win-avx2-x64';
    }
  }
}

function getGpuSuffix(): string {
  const platform = detectPlatform();
  const gpu = detectGpu();

  if (platform.startsWith('linux') && gpu.accel === 'vulkan') return '-vulkan';
  return '';
}

/**
 * Resolve the path to the sd-cli binary.
 *
 * 1. Check if `sd-cli` is on PATH
 * 2. Check if already downloaded to `<baseDir>/.sd-cpp/<platform>/`
 * 3. Download from GitHub releases
 */
export async function getSdCppBinaryPath(baseDir: string): Promise<string> {
  // 1. Check PATH
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const result = execFileSync(cmd, [BINARY_NAME], { encoding: 'utf-8' }).trim();
    if (result) {
      logger.info(`[SdCppBinary] Using system ${BINARY_NAME}: ${result.split('\n')[0]}`);
      return result.split('\n')[0]!;
    }
  } catch { /* not on PATH */ }

  // 2. Check local download
  const platform = detectPlatform();
  const binDir = path.join(baseDir, '.sd-cpp', platform);
  const binPath = path.join(binDir, BINARY_NAME);

  if (existsSync(binPath)) {
    return binPath;
  }

  // 3. Download
  await downloadSdCpp(binDir);
  return binPath;
}

async function downloadSdCpp(destDir: string): Promise<void> {
  logger.info('[SdCppBinary] Downloading sd-cli from GitHub...');

  const res = await fetch(RELEASES_API);
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const release: any = await res.json();

  const assetPattern = getAssetPattern();
  const gpuSuffix = getGpuSuffix();

  // Find matching asset, preferring GPU-specific builds
  let asset = release.assets?.find((a: any) => {
    const name = a.name as string;
    if (!name.includes(assetPattern)) return false;
    if (gpuSuffix && !name.includes(gpuSuffix)) return false;
    // Skip cudart packages
    if (name.startsWith('cudart-')) return false;
    return true;
  });

  // Fallback: try without GPU suffix
  if (!asset && gpuSuffix) {
    asset = release.assets?.find((a: any) => {
      const name = a.name as string;
      return name.includes(assetPattern) && !name.startsWith('cudart-');
    });
  }

  if (!asset) {
    throw new Error(
      `No sd-cli binary found for this platform. ` +
      `Looked for asset matching "${assetPattern}". ` +
      `Build it manually: https://github.com/leejet/stable-diffusion.cpp`
    );
  }

  const extractDir = await downloadAndExtract(destDir, asset);

  // Find the sd-cli binary in the extracted files
  const found = await findFileRecursive(extractDir, BINARY_NAME);
  if (found) {
    await copyAllFiles(path.dirname(found), destDir);
  } else {
    // Some releases put files at root of the zip
    await copyAllFiles(extractDir, destDir);
  }
  await fs.rm(extractDir, { recursive: true, force: true });

  // Make executable
  if (process.platform !== 'win32') {
    const entries = await fs.readdir(destDir);
    for (const name of entries) {
      await fs.chmod(path.join(destDir, name), 0o755).catch(() => {});
    }
  }

  const finalPath = path.join(destDir, BINARY_NAME);
  if (!existsSync(finalPath)) {
    throw new Error(`sd-cli binary not found after extraction. Check the release archive structure.`);
  }

  logger.info(`[SdCppBinary] sd-cli ready at ${finalPath}`);
}
