#!/usr/bin/env node

// ─── GPU Auto-Detection & Docker Launcher ────────────────────────────────────
// Detects host GPU vendor and launches the appropriate docker compose config.
//
// Usage:
//   node scripts/detect-gpu.mjs [OPTIONS]
//
// Options:
//   --yes, -y     Skip confirmation prompt (also: GPU_AUTO=true)
//   --nvidia      Force NVIDIA build (skip detection)
//   --amd         Force AMD build (skip detection)
//   --cpu         Force CPU-only build (skip detection)
// ─────────────────────────────────────────────────────────────────────────────

import { execSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { platform } from 'node:os';

// ─── Parse CLI arguments ─────────────────────────────────────────────────────
const args = process.argv.slice(2);
let autoYes = process.env.GPU_AUTO === 'true';
let forceVendor = '';

for (const arg of args) {
  switch (arg) {
    case '--yes': case '-y': autoYes = true; break;
    case '--nvidia': forceVendor = 'nvidia'; break;
    case '--amd': forceVendor = 'amd'; break;
    case '--cpu': forceVendor = 'cpu'; break;
    default: console.error(`Unknown option: ${arg}`); process.exit(1);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function exec(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

async function confirm(message) {
  if (autoYes) {
    console.log(`${message} [auto-confirmed]`);
    return true;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message} [Y/n] `, (answer) => {
      rl.close();
      resolve(!answer || /^y/i.test(answer));
    });
  });
}

function runDocker(vendor) {
  const composeArgs = { nvidia: ['-f', 'docker-compose.yaml', '-f', 'docker-compose.nvidia.yaml'],
    amd: ['-f', 'docker-compose.yaml', '-f', 'docker-compose.amd.yaml'],
    cpu: [] };

  const label = { nvidia: 'NVIDIA GPU', amd: 'AMD GPU', cpu: 'CPU-only' };
  console.log(`\n>> Launching with ${label[vendor]} support...`);

  // Detect GPU architecture to compile only for the installed GPU (much faster build)
  const env = { ...process.env };
  if (vendor === 'nvidia') {
    const arch = detectCudaArch();
    if (arch) {
      env.CUDA_ARCHITECTURES = arch;
      console.log(`>> Building CUDA kernels for architecture ${arch} only (faster build)`);
    }
  } else if (vendor === 'amd') {
    const arch = detectAmdArch();
    if (arch) {
      env.AMDGPU_TARGETS = arch;
      console.log(`>> Building ROCm kernels for ${arch} only (faster build)`);
    }
  }

  const child = spawn('docker', ['compose', ...composeArgs[vendor], 'up', '--build', '--watch'], {
    stdio: 'inherit',
    shell: true,
    env
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

// ─── Platform detection ──────────────────────────────────────────────────────
function detectPlatform() {
  const os = platform();
  if (os === 'darwin') return 'macos';
  if (os === 'win32') {
    // Check if running under WSL2 (unlikely from Node on Windows, but be safe)
    try {
      const procVersion = readFileSync('/proc/version', 'utf-8');
      if (/microsoft|wsl/i.test(procVersion)) return 'wsl2';
    } catch { /* not WSL */ }
    return 'windows';
  }
  if (os === 'linux') {
    try {
      const procVersion = readFileSync('/proc/version', 'utf-8');
      if (/microsoft|wsl/i.test(procVersion)) return 'wsl2';
    } catch { /* ignore */ }
    return 'linux';
  }
  return 'unknown';
}

// ─── CUDA architecture detection ─────────────────────────────────────────────
function detectCudaArch() {
  // Query compute capability (e.g. "12.0" → "120", "8.6" → "86")
  const cap = exec('nvidia-smi --query-gpu=compute_cap --format=csv,noheader');
  if (cap) {
    const arch = cap.split('\n')[0].trim().replace('.', '');
    if (/^\d+$/.test(arch)) {
      console.log(`   CUDA architecture: ${arch} (compute ${cap.split('\n')[0].trim()})`);
      return arch;
    }
  }
  return '';
}

// ─── AMD architecture detection ──────────────────────────────────────────────
function detectAmdArch() {
  // Try rocminfo (reports gfx target directly, e.g. "gfx1100")
  const rocminfo = exec('rocminfo 2>/dev/null');
  if (rocminfo) {
    const match = rocminfo.match(/gfx\d+/);
    if (match) {
      console.log(`   AMD GPU target: ${match[0]}`);
      return match[0];
    }
  }

  // Try rocm-smi for GPU ID, then map to gfx target
  const smi = exec('rocm-smi --showuniqueid 2>/dev/null');
  if (smi) {
    // Extract device name and attempt gfx mapping from known models
    const productInfo = exec('rocm-smi --showproductname 2>/dev/null');
    if (productInfo) {
      // Common mappings: RX 7900 → gfx1100, RX 7800/7700 → gfx1101, RX 6900/6800 → gfx1030
      if (/7900/i.test(productInfo)) return 'gfx1100';
      if (/7800|7700/i.test(productInfo)) return 'gfx1101';
      if (/6900|6800|6700/i.test(productInfo)) return 'gfx1030';
      if (/instinct mi250/i.test(productInfo)) return 'gfx90a';
      if (/instinct mi100/i.test(productInfo)) return 'gfx908';
    }
  }

  return '';
}

// ─── GPU detection ───────────────────────────────────────────────────────────
function detectNvidia() {
  // nvidia-smi works on Linux, WSL2, and Windows
  let gpu = exec('nvidia-smi --query-gpu=name --format=csv,noheader');
  if (gpu) return gpu.split('\n')[0].trim();

  // WSL2 fallback
  if (existsSync('/usr/lib/wsl/lib/nvidia-smi')) {
    gpu = exec('/usr/lib/wsl/lib/nvidia-smi --query-gpu=name --format=csv,noheader');
    if (gpu) return gpu.split('\n')[0].trim();
  }

  // Linux fallback: lspci
  gpu = exec("lspci 2>/dev/null | grep -i nvidia | grep -iE 'vga|3d|display' | head -1 | sed 's/.*: //'");
  if (gpu) return gpu;

  // Windows fallback: wmic
  if (platform() === 'win32') {
    const wmic = exec('wmic path win32_VideoController get name');
    const nvidia = wmic.split('\n').find(l => /nvidia/i.test(l));
    if (nvidia) return nvidia.trim();
  }

  return '';
}

function detectAmd() {
  // rocm-smi
  let gpu = exec("rocm-smi --showproductname 2>/dev/null | grep -i card | head -1 | sed 's/.*: //'");
  if (gpu) return gpu;

  // Linux: lspci
  gpu = exec("lspci 2>/dev/null | grep -iE 'amd|radeon|advanced micro' | grep -iE 'vga|3d|display' | head -1 | sed 's/.*: //'");
  if (gpu) return gpu;

  // Linux: sysfs vendor check (0x1002 = AMD)
  try {
    const drmPath = '/sys/class/drm';
    if (existsSync(drmPath)) {
      for (const entry of readdirSync(drmPath)) {
        const vendorFile = `${drmPath}/${entry}/device/vendor`;
        if (existsSync(vendorFile)) {
          const vendor = readFileSync(vendorFile, 'utf-8').trim();
          if (vendor === '0x1002') return 'AMD GPU (detected via sysfs)';
        }
      }
    }
  } catch { /* ignore */ }

  // Windows: wmic
  if (platform() === 'win32') {
    const wmic = exec('wmic path win32_VideoController get name');
    const amd = wmic.split('\n').find(l => /amd|radeon/i.test(l));
    if (amd) return amd.trim();
  }

  return '';
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║   Agent Orcha — GPU Auto-Detection   ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('');

  // Handle forced vendor
  if (forceVendor) {
    console.log(`>> Forced mode: ${forceVendor}`);
    runDocker(forceVendor);
    return;
  }

  // Detect platform
  const plat = detectPlatform();
  console.log(`>> Platform: ${plat}`);

  // macOS: no GPU passthrough
  if (plat === 'macos') {
    console.log('');
    console.log('!  Docker on macOS does not support GPU passthrough.');
    console.log('   Apple Silicon Metal is not available inside containers.');
    console.log('   For GPU acceleration on Mac, run Agent Orcha natively.');
    console.log('');
    console.log('>> Falling back to CPU-only build.');
    runDocker('cpu');
    return;
  }

  // Detect GPUs
  console.log('>> Scanning for GPUs...');
  const nvidiaGpu = detectNvidia();
  const amdGpu = detectAmd();

  if (nvidiaGpu) console.log(`   NVIDIA: ${nvidiaGpu}`);
  if (amdGpu) console.log(`   AMD:    ${amdGpu}`);

  // Both detected
  if (nvidiaGpu && amdGpu) {
    console.log('');
    console.log('>> Both NVIDIA and AMD GPUs detected. Defaulting to NVIDIA (CUDA).');
    console.log('   Use --amd to force AMD (ROCm) instead.');
    console.log('');
    if (await confirm('Build with NVIDIA CUDA support?')) {
      runDocker('nvidia');
    } else if (await confirm('Build with AMD ROCm support instead?')) {
      runDocker('amd');
    } else {
      console.log('>> Cancelled.');
    }

  // NVIDIA only
  } else if (nvidiaGpu) {
    console.log('');
    if (await confirm('Build with NVIDIA CUDA support?')) {
      runDocker('nvidia');
    } else {
      console.log('>> Cancelled.');
    }

  // AMD only
  } else if (amdGpu) {
    console.log('');
    if (plat === 'wsl2') {
      console.log('!  AMD ROCm on WSL2 is experimental and may have limited support.');
    }
    if (await confirm('Build with AMD ROCm support?')) {
      runDocker('amd');
    } else {
      console.log('>> Cancelled.');
    }

  // No GPU detected
  } else {
    console.log('');
    console.log('>> No compatible GPU detected.');
    if (!autoYes) {
      console.log('   Ensure drivers are installed (nvidia-smi / rocm-smi) or use:');
      console.log('     --nvidia  Force NVIDIA build');
      console.log('     --amd     Force AMD build');
      console.log('     --cpu     Build without GPU support');
      console.log('');
    }
    if (await confirm('Continue with CPU-only build?')) {
      runDocker('cpu');
    } else {
      console.log('>> Cancelled.');
    }
  }
}

main();
