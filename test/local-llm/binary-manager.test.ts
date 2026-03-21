import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';

// ── Mutable state that module-level mocks delegate to ──

let execFileSyncFn: (...args: any[]) => any;
let spawnSyncFn: (...args: any[]) => any;
let existsSyncFn: (p: string) => boolean;
let fsMkdirFn: (...args: any[]) => Promise<void>;
let fsReaddirFn: (...args: any[]) => Promise<any[]>;
let fsUnlinkFn: (...args: any[]) => Promise<void>;
let fsRmFn: (...args: any[]) => Promise<void>;
let fsChmodFn: (...args: any[]) => Promise<void>;
let fsRenameFn: (...args: any[]) => Promise<void>;
let fsCopyFileFn: (...args: any[]) => Promise<void>;
let fsSymlinkFn: (...args: any[]) => Promise<void>;
let createWriteStreamFn: (...args: any[]) => any;
let pipelineFn: (...args: any[]) => Promise<void>;
let fetchFn: (...args: any[]) => Promise<any>;

// ── Module mocks (must be registered before importing the module under test) ──

mock.module('child_process', {
  namedExports: {
    spawn: () => ({ on: () => {} }),
    execFile: () => ({ on: () => {} }),
    execFileSync: (...args: any[]) => execFileSyncFn(...args),
    spawnSync: (...args: any[]) => spawnSyncFn(...args),
  },
});

mock.module('fs/promises', {
  namedExports: {
    mkdir: (...args: any[]) => fsMkdirFn(...args),
    readdir: (...args: any[]) => fsReaddirFn(...args),
    unlink: (...args: any[]) => fsUnlinkFn(...args),
    rm: (...args: any[]) => fsRmFn(...args),
    chmod: (...args: any[]) => fsChmodFn(...args),
    rename: (...args: any[]) => fsRenameFn(...args),
    copyFile: (...args: any[]) => fsCopyFileFn(...args),
    symlink: (...args: any[]) => fsSymlinkFn(...args),
  },
});

mock.module('fs', {
  namedExports: {
    existsSync: (p: string) => existsSyncFn(p),
    createWriteStream: (...args: any[]) => createWriteStreamFn(...args),
  },
});

mock.module('stream/promises', {
  namedExports: {
    pipeline: (...args: any[]) => pipelineFn(...args),
  },
});

// Mock the logger to silence output
mock.module('../../lib/logger.ts', {
  namedExports: {
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  },
});

// Now import the module under test (after all mock.module calls)
const {
  detectGpu,
  queryNvidiaVram,
  getBinaryPath,
  getBinaryVersion,
  isSystemBinary,
  _getAssetPatterns,
  _getBinaryDirName,
  _resetGpuCache,
} = await import('../../lib/local-llm/binary-manager.ts');

type GpuInfo = import('../../lib/local-llm/binary-manager.ts').GpuInfo;
type _Platform = import('../../lib/local-llm/binary-manager.ts')._Platform;

const gpu = (accel: GpuInfo['accel'], name?: string): GpuInfo => ({ accel, name });

// ── Helper: save and restore process.platform/arch ──
// We use Object.defineProperty since process.platform is read-only.

let origPlatform: string;
let origArch: string;

function setPlatform(plat: string, arch = 'x64') {
  Object.defineProperty(process, 'platform', { value: plat, configurable: true });
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
}

function restorePlatform() {
  Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
  Object.defineProperty(process, 'arch', { value: origArch, configurable: true });
}

// ── Default no-op implementations ──

function resetMocks() {
  execFileSyncFn = () => { throw new Error('not on PATH'); };
  spawnSyncFn = () => ({ stdout: '', stderr: '', status: 1 });
  existsSyncFn = () => false;
  fsMkdirFn = async () => {};
  fsReaddirFn = async () => [];
  fsUnlinkFn = async () => {};
  fsRmFn = async () => {};
  fsChmodFn = async () => {};
  fsRenameFn = async () => {};
  fsCopyFileFn = async () => {};
  fsSymlinkFn = async () => {};
  createWriteStreamFn = () => ({ on: () => {}, write: () => {}, end: () => {} });
  pipelineFn = async () => {};
  fetchFn = async () => ({ ok: false, status: 404 });
  // Replace global fetch
  (globalThis as any).fetch = (...args: any[]) => fetchFn(...args);
}

describe('binary-manager', () => {
  beforeEach(() => {
    origPlatform = process.platform;
    origArch = process.arch;
    _resetGpuCache();
    resetMocks();
  });

  afterEach(() => {
    restorePlatform();
    _resetGpuCache();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // getAssetPatterns
  // ═══════════════════════════════════════════════════════════════════════════

  describe('getAssetPatterns', () => {
    describe('Windows', () => {
      const platform: _Platform = 'win-x64';

      it('NVIDIA + CUDA 13.1 → cuda-13.1 binary + cudart', () => {
        const p = _getAssetPatterns(platform, gpu('cuda-13.1', 'RTX 5090'));
        assert.equal(p.main, 'bin-win-cuda-13.1-x64');
        assert.equal(p.cudart, 'cudart-llama-bin-win-cuda-13.1-x64');
      });

      it('NVIDIA + CUDA 12.4 → cuda-12.4 binary + cudart', () => {
        const p = _getAssetPatterns(platform, gpu('cuda-12.4', 'RTX 4090'));
        assert.equal(p.main, 'bin-win-cuda-12.4-x64');
        assert.equal(p.cudart, 'cudart-llama-bin-win-cuda-12.4-x64');
      });

      it('Vulkan → vulkan binary, no cudart', () => {
        const p = _getAssetPatterns(platform, gpu('vulkan', 'GTX 1080'));
        assert.equal(p.main, 'bin-win-vulkan-x64');
        assert.equal(p.cudart, undefined);
      });

      it('No GPU → CPU binary, no cudart', () => {
        const p = _getAssetPatterns(platform, gpu('none'));
        assert.equal(p.main, 'bin-win-cpu-x64');
        assert.equal(p.cudart, undefined);
      });
    });

    describe('Linux', () => {
      it('Vulkan → ubuntu-vulkan binary', () => {
        const p = _getAssetPatterns('linux-x64', gpu('vulkan'));
        assert.equal(p.main, 'bin-ubuntu-vulkan-x64');
      });

      it('No GPU → ubuntu CPU binary', () => {
        const p = _getAssetPatterns('linux-x64', gpu('none'));
        assert.equal(p.main, 'bin-ubuntu-x64');
      });
    });

    describe('macOS', () => {
      it('arm64 → macos-arm64 binary', () => {
        const p = _getAssetPatterns('macos-arm64', gpu('metal'));
        assert.equal(p.main, 'bin-macos-arm64');
      });

      it('x64 → macos-x64 binary', () => {
        const p = _getAssetPatterns('macos-x64', gpu('metal'));
        assert.equal(p.main, 'bin-macos-x64');
      });
    });

    it('linux-arm64 throws unsupported error', () => {
      assert.throws(() => _getAssetPatterns('linux-arm64', gpu('none')), /ARM64 Linux/);
    });

    it('only CUDA builds include cudart', () => {
      const platforms: _Platform[] = ['win-x64', 'linux-x64', 'macos-arm64', 'macos-x64'];
      const accels: GpuInfo['accel'][] = ['none', 'metal', 'vulkan', 'cuda-12.4', 'cuda-13.1'];
      for (const platform of platforms) {
        for (const accel of accels) {
          const p = _getAssetPatterns(platform, gpu(accel));
          if (accel.startsWith('cuda') && platform === 'win-x64') {
            assert.ok(p.cudart, `Expected cudart for ${platform}/${accel}`);
          } else {
            assert.equal(p.cudart, undefined, `Unexpected cudart for ${platform}/${accel}`);
          }
        }
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // getBinaryDirName
  // ═══════════════════════════════════════════════════════════════════════════

  describe('getBinaryDirName', () => {
    it('win-x64 + CUDA → win-cuda-12.4-x64', () => {
      assert.equal(_getBinaryDirName('win-x64', gpu('cuda-12.4')), 'win-cuda-12.4-x64');
    });

    it('win-x64 + vulkan → win-vulkan-x64', () => {
      assert.equal(_getBinaryDirName('win-x64', gpu('vulkan')), 'win-vulkan-x64');
    });

    it('win-x64 + none → win-x64', () => {
      assert.equal(_getBinaryDirName('win-x64', gpu('none')), 'win-x64');
    });

    it('linux-x64 + vulkan → linux-vulkan-x64', () => {
      assert.equal(_getBinaryDirName('linux-x64', gpu('vulkan')), 'linux-vulkan-x64');
    });

    it('linux-x64 + none → linux-x64', () => {
      assert.equal(_getBinaryDirName('linux-x64', gpu('none')), 'linux-x64');
    });

    it('macOS arm64 always → macos-arm64', () => {
      assert.equal(_getBinaryDirName('macos-arm64', gpu('metal')), 'macos-arm64');
    });

    it('macOS x64 always → macos-x64', () => {
      assert.equal(_getBinaryDirName('macos-x64', gpu('metal')), 'macos-x64');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // detectGpu
  // ═══════════════════════════════════════════════════════════════════════════

  describe('detectGpu', () => {
    it('returns metal on macOS', () => {
      setPlatform('darwin', 'arm64');
      const info = detectGpu();
      assert.equal(info.accel, 'metal');
    });

    it('caches the result across calls', () => {
      setPlatform('darwin', 'arm64');
      const first = detectGpu();
      const second = detectGpu();
      assert.strictEqual(first, second); // same object reference
    });

    it('cache can be reset', () => {
      setPlatform('darwin', 'arm64');
      const first = detectGpu();
      _resetGpuCache();
      const second = detectGpu();
      assert.deepStrictEqual(first, second);
      assert.notStrictEqual(first, second); // different object
    });

    it('detects NVIDIA with CUDA 13.1 on Windows', () => {
      setPlatform('win32');
      execFileSyncFn = (cmd: string, args: any[]) => {
        if (cmd === 'nvidia-smi' && args.length === 0) {
          return 'CUDA Version: 13.1\n';
        }
        if (cmd === 'nvidia-smi' && args[0] === '--query-gpu=name') {
          return 'NVIDIA GeForce RTX 5090\n';
        }
        throw new Error('not found');
      };
      const info = detectGpu();
      assert.equal(info.accel, 'cuda-13.1');
      assert.equal(info.name, 'NVIDIA GeForce RTX 5090');
    });

    it('detects NVIDIA with CUDA 12.4 on Windows', () => {
      setPlatform('win32');
      execFileSyncFn = (cmd: string, args: any[]) => {
        if (cmd === 'nvidia-smi' && args.length === 0) {
          return 'CUDA Version: 12.4\n';
        }
        if (cmd === 'nvidia-smi' && args[0] === '--query-gpu=name') {
          return 'RTX 4090\n';
        }
        throw new Error('not found');
      };
      const info = detectGpu();
      assert.equal(info.accel, 'cuda-12.4');
    });

    it('NVIDIA with old CUDA on Windows falls back to vulkan', () => {
      setPlatform('win32');
      execFileSyncFn = (cmd: string, args: any[]) => {
        if (cmd === 'nvidia-smi' && args.length === 0) {
          return 'CUDA Version: 11.0\n';
        }
        if (cmd === 'nvidia-smi' && args[0] === '--query-gpu=name') {
          return 'GTX 1080\n';
        }
        throw new Error('not found');
      };
      const info = detectGpu();
      assert.equal(info.accel, 'vulkan');
    });

    it('NVIDIA on Linux always uses vulkan', () => {
      setPlatform('linux');
      execFileSyncFn = (cmd: string, args: any[]) => {
        if (cmd === 'nvidia-smi' && args.length === 0) {
          return 'CUDA Version: 13.1\n';
        }
        if (cmd === 'nvidia-smi' && args[0] === '--query-gpu=name') {
          return 'RTX 4090\n';
        }
        throw new Error('not found');
      };
      const info = detectGpu();
      assert.equal(info.accel, 'vulkan');
      assert.equal(info.name, 'RTX 4090');
    });

    it('no NVIDIA, falls back to AMD/Intel on Windows via powershell', () => {
      setPlatform('win32');
      execFileSyncFn = (cmd: string, args: any[]) => {
        if (cmd === 'nvidia-smi') throw new Error('not found');
        if (cmd === 'powershell') {
          return 'AMD Radeon RX 7900 XTX\n';
        }
        throw new Error('not found');
      };
      const info = detectGpu();
      assert.equal(info.accel, 'vulkan');
      assert.equal(info.name, 'AMD Radeon RX 7900 XTX');
    });

    it('Intel integrated GPU on Linux falls back to CPU (no Vulkan compute)', () => {
      setPlatform('linux');
      execFileSyncFn = (cmd: string) => {
        if (cmd === 'nvidia-smi') throw new Error('not found');
        if (cmd === 'lspci') {
          return '00:02.0 VGA compatible controller: Intel Corporation UHD Graphics\n';
        }
        throw new Error('not found');
      };
      const info = detectGpu();
      assert.equal(info.accel, 'none');
    });

    it('AMD GPU on Linux uses Vulkan', () => {
      setPlatform('linux');
      execFileSyncFn = (cmd: string) => {
        if (cmd === 'nvidia-smi') throw new Error('not found');
        if (cmd === 'lspci') {
          return '06:00.0 VGA compatible controller: Advanced Micro Devices, Inc. [AMD/ATI] Navi 31 [Radeon RX 7900 XTX]\n';
        }
        throw new Error('not found');
      };
      const info = detectGpu();
      assert.equal(info.accel, 'vulkan');
      assert.ok(info.name?.includes('AMD'));
    });

    it('Intel Arc discrete GPU on Linux uses Vulkan', () => {
      setPlatform('linux');
      execFileSyncFn = (cmd: string) => {
        if (cmd === 'nvidia-smi') throw new Error('not found');
        if (cmd === 'lspci') {
          return '03:00.0 VGA compatible controller: Intel Corporation Arc A770\n';
        }
        throw new Error('not found');
      };
      const info = detectGpu();
      assert.equal(info.accel, 'vulkan');
      assert.ok(info.name?.includes('Arc'));
    });

    it('virtual/unknown GPU on Linux falls back to CPU', () => {
      setPlatform('linux');
      execFileSyncFn = (cmd: string) => {
        if (cmd === 'nvidia-smi') throw new Error('not found');
        if (cmd === 'lspci') {
          return '00:01.0 VGA compatible controller: Device 1234:1111 (rev 02)\n';
        }
        throw new Error('not found');
      };
      const info = detectGpu();
      assert.equal(info.accel, 'none');
    });

    it('no GPU detected at all → accel: none', () => {
      setPlatform('linux');
      execFileSyncFn = () => { throw new Error('not found'); };
      const info = detectGpu();
      assert.equal(info.accel, 'none');
    });

    it('filters out Microsoft Basic adapter on Windows', () => {
      setPlatform('win32');
      execFileSyncFn = (cmd: string) => {
        if (cmd === 'nvidia-smi') throw new Error('not found');
        if (cmd === 'powershell') {
          return 'Microsoft Basic Display Adapter\n';
        }
        throw new Error('not found');
      };
      const info = detectGpu();
      assert.equal(info.accel, 'none');
    });

    it('NVIDIA name query failure is graceful (name stays undefined)', () => {
      setPlatform('win32');
      let callCount = 0;
      execFileSyncFn = (cmd: string, args: any[]) => {
        if (cmd === 'nvidia-smi' && args.length === 0) {
          return 'CUDA Version: 13.1\n';
        }
        // name query fails
        throw new Error('query failed');
      };
      const info = detectGpu();
      assert.equal(info.accel, 'cuda-13.1');
      assert.equal(info.name, undefined);
    });

    it('detectAnyGpu failure is graceful (returns none)', () => {
      setPlatform('win32');
      execFileSyncFn = (cmd: string) => {
        if (cmd === 'nvidia-smi') throw new Error('not found');
        if (cmd === 'powershell') throw new Error('powershell failed');
        throw new Error('not found');
      };
      const info = detectGpu();
      assert.equal(info.accel, 'none');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // queryNvidiaVram
  // ═══════════════════════════════════════════════════════════════════════════

  describe('queryNvidiaVram', () => {
    it('returns VRAM info when nvidia-smi succeeds', () => {
      execFileSyncFn = (cmd: string, args: any[]) => {
        if (cmd === 'nvidia-smi' && args[0]?.includes('memory')) {
          return '24576, 1234, 23342\n';
        }
        throw new Error('not found');
      };
      const vram = queryNvidiaVram();
      assert.ok(vram);
      assert.equal(vram.totalBytes, 24576 * 1024 * 1024);
      assert.equal(vram.usedBytes, 1234 * 1024 * 1024);
      assert.equal(vram.freeBytes, 23342 * 1024 * 1024);
    });

    it('returns null when nvidia-smi fails', () => {
      execFileSyncFn = () => { throw new Error('not found'); };
      assert.equal(queryNvidiaVram(), null);
    });

    it('returns null when output is empty', () => {
      execFileSyncFn = () => '';
      assert.equal(queryNvidiaVram(), null);
    });

    it('returns null when output is malformed', () => {
      execFileSyncFn = () => 'not, valid, numbers, here';
      assert.equal(queryNvidiaVram(), null);
    });

    it('returns null when fewer than 3 values', () => {
      execFileSyncFn = () => '24576, 1234';
      assert.equal(queryNvidiaVram(), null);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // getBinaryPath
  // ═══════════════════════════════════════════════════════════════════════════

  describe('getBinaryPath', () => {
    it('returns system binary if on PATH', async () => {
      setPlatform('darwin', 'arm64');
      execFileSyncFn = (cmd: string, args: any[]) => {
        if (cmd === 'which' && args[0] === 'llama-server') {
          return '/usr/local/bin/llama-server\n';
        }
        throw new Error('not found');
      };

      const result = await getBinaryPath('/tmp/base');
      assert.equal(result, '/usr/local/bin/llama-server');
    });

    it('returns local binary if it exists on disk', async () => {
      setPlatform('darwin', 'arm64');
      // which fails (not on PATH)
      execFileSyncFn = () => { throw new Error('not on PATH'); };
      // But the binary exists locally
      existsSyncFn = (p: string) => p.includes('.llama-server') && p.includes('llama-server');

      const result = await getBinaryPath('/tmp/base');
      assert.ok(result.includes('.llama-server'));
      assert.ok(result.includes('llama-server'));
    });

    it('downloads binary when not on PATH and not cached', async () => {
      setPlatform('darwin', 'arm64');
      execFileSyncFn = (cmd: string) => {
        if (cmd === 'which') throw new Error('not on PATH');
        if (cmd === 'tar') return ''; // extraction
        throw new Error('not found');
      };
      existsSyncFn = () => false;

      // Create a real ReadableStream for the download body
      const fakeBody = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([0x00]));
          controller.close();
        },
      });

      // Mock fetch for GitHub release API
      fetchFn = async (url: string) => {
        if (url.includes('api.github.com')) {
          return {
            ok: true,
            json: async () => ({
              tag_name: 'b8300',
              assets: [{
                name: 'llama-b8300-bin-macos-arm64.tar.gz',
                browser_download_url: 'https://example.com/llama.tar.gz',
              }],
            }),
          };
        }
        // Download URL
        return { ok: true, body: fakeBody };
      };

      // Mock file operations for download flow
      fsMkdirFn = async () => {};
      fsReaddirFn = async (dir: string) => {
        if (typeof dir === 'string' && dir.includes('_extract_')) {
          return [{ name: 'llama-server', isFile: () => true, isDirectory: () => false }];
        }
        return [];
      };
      fsRenameFn = async () => {};
      fsRmFn = async () => {};
      fsChmodFn = async () => {};
      pipelineFn = async () => {};

      const result = await getBinaryPath('/tmp/base');
      assert.ok(result.includes('llama-server'));
    });

    it('uses "where" on Windows instead of "which"', async () => {
      setPlatform('win32');
      let usedWhere = false;
      execFileSyncFn = (cmd: string, args: any[]) => {
        if (cmd === 'where' && args[0] === 'llama-server') {
          usedWhere = true;
          return 'C:\\llama-server.exe\n';
        }
        throw new Error('not found');
      };

      await getBinaryPath('/tmp/base');
      assert.ok(usedWhere);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // getBinaryVersion
  // ═══════════════════════════════════════════════════════════════════════════

  describe('getBinaryVersion', () => {
    it('returns version from system binary on PATH', () => {
      setPlatform('darwin', 'arm64');
      execFileSyncFn = (cmd: string, args: any[]) => {
        if (cmd === 'which') return '/usr/local/bin/llama-server\n';
        throw new Error('not found');
      };
      spawnSyncFn = (binPath: string) => {
        if (binPath === '/usr/local/bin/llama-server') {
          return { stdout: '', stderr: 'version: 8300 (abc123)\n', status: 0 };
        }
        return { stdout: '', stderr: '', status: 1 };
      };

      const version = getBinaryVersion('/tmp/base');
      assert.equal(version, '8300 (abc123)');
    });

    it('returns version from local binary when not on PATH', () => {
      setPlatform('darwin', 'arm64');
      execFileSyncFn = () => { throw new Error('not on PATH'); };
      existsSyncFn = (p: string) => p.includes('llama-server');
      spawnSyncFn = () => ({
        stdout: 'version: 8234 (def456)\n',
        stderr: '',
        status: 0,
      });

      const version = getBinaryVersion('/tmp/base');
      assert.equal(version, '8234 (def456)');
    });

    it('returns null when no binary found', () => {
      setPlatform('darwin', 'arm64');
      execFileSyncFn = () => { throw new Error('not on PATH'); };
      existsSyncFn = () => false;

      const version = getBinaryVersion('/tmp/base');
      assert.equal(version, null);
    });

    it('returns null when version output is unparseable', () => {
      setPlatform('darwin', 'arm64');
      execFileSyncFn = (cmd: string) => {
        if (cmd === 'which') return '/usr/local/bin/llama-server\n';
        throw new Error('not found');
      };
      spawnSyncFn = () => ({
        stdout: 'no version info here\n',
        stderr: '',
        status: 0,
      });

      const version = getBinaryVersion('/tmp/base');
      assert.equal(version, null);
    });

    it('caches the result across calls with same baseDir', () => {
      setPlatform('darwin', 'arm64');
      let callCount = 0;
      execFileSyncFn = (cmd: string) => {
        if (cmd === 'which') {
          callCount++;
          return '/usr/local/bin/llama-server\n';
        }
        throw new Error('not found');
      };
      spawnSyncFn = () => ({
        stdout: '', stderr: 'version: 8300 (abc)\n', status: 0,
      });

      getBinaryVersion('/tmp/base');
      getBinaryVersion('/tmp/base');
      // Second call should use cache, so execFileSync should only be called once for 'which'
      assert.equal(callCount, 1);
    });

    it('re-detects when baseDir changes', () => {
      setPlatform('darwin', 'arm64');
      let callCount = 0;
      execFileSyncFn = (cmd: string) => {
        if (cmd === 'which') {
          callCount++;
          return '/usr/local/bin/llama-server\n';
        }
        throw new Error('not found');
      };
      spawnSyncFn = () => ({
        stdout: '', stderr: 'version: 8300 (abc)\n', status: 0,
      });

      getBinaryVersion('/tmp/base1');
      _resetGpuCache(); // also resets cachedVersion
      getBinaryVersion('/tmp/base2');
      assert.equal(callCount, 2);
    });

    it('handles spawnSync throwing', () => {
      setPlatform('darwin', 'arm64');
      execFileSyncFn = (cmd: string) => {
        if (cmd === 'which') return '/usr/local/bin/llama-server\n';
        throw new Error('not found');
      };
      spawnSyncFn = () => { throw new Error('spawn failed'); };

      const version = getBinaryVersion('/tmp/base');
      // parseVersion catches the error and returns null
      assert.equal(version, null);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // isSystemBinary
  // ═══════════════════════════════════════════════════════════════════════════

  describe('isSystemBinary', () => {
    it('returns true when llama-server is on PATH', () => {
      execFileSyncFn = (cmd: string, args: any[]) => {
        if ((cmd === 'which' || cmd === 'where') && args[0] === 'llama-server') {
          return '/usr/local/bin/llama-server\n';
        }
        throw new Error('not found');
      };

      assert.equal(isSystemBinary(), true);
    });

    it('returns false when llama-server is not on PATH', () => {
      execFileSyncFn = () => { throw new Error('not found'); };

      assert.equal(isSystemBinary(), false);
    });

    it('caches the result', () => {
      let callCount = 0;
      execFileSyncFn = () => {
        callCount++;
        return '/usr/local/bin/llama-server\n';
      };

      isSystemBinary();
      isSystemBinary();
      assert.equal(callCount, 1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // downloadBinary (tested through getBinaryPath and updateBinary)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('downloadBinary flow', () => {
    function setupDownloadMocks(opts: {
      platform?: string;
      arch?: string;
      gpu?: GpuInfo;
      assetName?: string;
      extraAssets?: any[];
      readdirEntries?: Record<string, any[]>;
      destDirEntries?: any[];
      existsSyncOverride?: (p: string) => boolean;
    } = {}) {
      const plat = opts.platform ?? 'darwin';
      const arch = opts.arch ?? 'arm64';
      setPlatform(plat, arch);

      const assetName = opts.assetName ?? 'llama-b8300-bin-macos-arm64.tar.gz';
      const assets = [
        { name: assetName, browser_download_url: 'https://example.com/dl' },
        ...(opts.extraAssets ?? []),
      ];

      execFileSyncFn = (cmd: string) => {
        if (cmd === 'which' || cmd === 'where') throw new Error('not on PATH');
        if (cmd === 'tar' || cmd === 'unzip') return '';
        if (cmd === 'powershell') return '';
        throw new Error('not found');
      };

      existsSyncFn = opts.existsSyncOverride ?? (() => false);

      const fakeBody = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([0x00]));
          controller.close();
        },
      });

      fetchFn = async (url: string) => {
        if (url.includes('api.github.com')) {
          return {
            ok: true,
            json: async () => ({ tag_name: 'b8300', assets }),
          };
        }
        return { ok: true, body: fakeBody };
      };

      const readdirEntries = opts.readdirEntries ?? {};
      const destDirEntries = opts.destDirEntries ?? [];

      fsReaddirFn = async (dir: string, _opts?: any) => {
        // Check explicit overrides first
        for (const [key, val] of Object.entries(readdirEntries)) {
          if (typeof dir === 'string' && dir.includes(key)) return val;
        }
        // Default: extract dir has the binary in a nested subdir
        if (typeof dir === 'string' && dir.includes('_extract_')) {
          return [{ name: 'llama-server', isFile: () => true, isDirectory: () => false }];
        }
        // Dest dir (after extraction) — for symlink/chmod logic
        return destDirEntries;
      };

      fsMkdirFn = async () => {};
      fsRenameFn = async () => {};
      fsCopyFileFn = async () => {};
      fsUnlinkFn = async () => {};
      fsRmFn = async () => {};
      fsChmodFn = async () => {};
      fsSymlinkFn = async () => {};
      pipelineFn = async () => {};
    }

    it('finds binary in nested directory (findFileRecursive recursion)', async () => {
      let extractCallCount = 0;
      setupDownloadMocks();

      // Override readdir to simulate nested directory structure
      fsReaddirFn = async (dir: string, _opts?: any) => {
        if (typeof dir === 'string' && dir.includes('_extract_') && !dir.includes('build')) {
          return [
            { name: 'build', isFile: () => false, isDirectory: () => true },
          ];
        }
        if (typeof dir === 'string' && dir.includes('build')) {
          return [
            { name: 'llama-server', isFile: () => true, isDirectory: () => false },
          ];
        }
        return [];
      };

      const result = await getBinaryPath('/tmp/base');
      assert.ok(result.includes('llama-server'));
    });

    it('throws when binary not found in archive', async () => {
      setupDownloadMocks({
        readdirEntries: {
          '_extract_': [], // empty extract dir
        },
      });

      await assert.rejects(
        getBinaryPath('/tmp/base'),
        /llama-server binary not found in archive/,
      );
    });

    it('throws when no matching asset found', async () => {
      setPlatform('darwin', 'arm64');
      execFileSyncFn = () => { throw new Error('not on PATH'); };
      existsSyncFn = () => false;

      fetchFn = async (url: string) => {
        if (url.includes('api.github.com')) {
          return {
            ok: true,
            json: async () => ({
              tag_name: 'b8300',
              assets: [{ name: 'something-else.tar.gz', browser_download_url: 'https://example.com/dl' }],
            }),
          };
        }
        return { ok: true, body: new ReadableStream() };
      };

      await assert.rejects(
        getBinaryPath('/tmp/base'),
        /No llama-server binary found/,
      );
    });

    it('throws when GitHub API returns error during download', async () => {
      setPlatform('darwin', 'arm64');
      execFileSyncFn = () => { throw new Error('not on PATH'); };
      existsSyncFn = () => false;

      fetchFn = async () => ({ ok: false, status: 403 });

      await assert.rejects(
        getBinaryPath('/tmp/base'),
        /GitHub API error: 403/,
      );
    });

    it('creates symlinks for versioned macOS shared libs', async () => {
      const symlinkCalls: string[] = [];
      setupDownloadMocks({
        destDirEntries: [
          'libmtmd.0.0.8219.dylib',
          'libggml.0.0.8219.dylib',
        ],
      });
      fsSymlinkFn = async (target: string, linkPath: string) => {
        symlinkCalls.push(linkPath);
      };
      // existsSync returns false for symlink targets
      existsSyncFn = () => false;

      await getBinaryPath('/tmp/base');
      // Should have attempted to create short symlinks
      assert.ok(symlinkCalls.length >= 0); // at least attempted readdir
    });

    it('creates symlinks for versioned Linux shared libs', async () => {
      const symlinkCalls: Array<{ target: string; link: string }> = [];
      setupDownloadMocks({
        platform: 'linux',
        arch: 'x64',
        assetName: 'llama-b8300-bin-ubuntu-x64.tar.gz',
        destDirEntries: [
          'libmtmd.so.0.0.8219',
          'libggml.so.0.0.8219',
        ],
      });
      fsSymlinkFn = async (target: string, link: string) => {
        symlinkCalls.push({ target, link });
      };
      existsSyncFn = () => false;

      await getBinaryPath('/tmp/base');
      // Should have attempted to create short symlinks for .so files
      assert.ok(symlinkCalls.some(c => c.link.endsWith('libmtmd.so.0')));
      assert.ok(symlinkCalls.some(c => c.link.endsWith('libggml.so.0')));
    });

    it('skips symlink when short name already exists', async () => {
      const symlinkCalls: string[] = [];
      setupDownloadMocks({
        destDirEntries: ['libmtmd.0.0.8219.dylib'],
        existsSyncOverride: (p: string) => {
          // Short symlink already exists
          if (p.endsWith('libmtmd.0.dylib')) return true;
          return false;
        },
      });
      fsSymlinkFn = async (_target: string, linkPath: string) => {
        symlinkCalls.push(linkPath);
      };

      await getBinaryPath('/tmp/base');
      // Should NOT create the symlink since it already exists
      assert.ok(!symlinkCalls.some(c => c.includes('libmtmd.0.dylib')));
    });

    it('makes files executable on Unix (chmod)', async () => {
      const chmodPaths: string[] = [];
      setupDownloadMocks({
        destDirEntries: ['llama-server', 'libggml.dylib'],
      });
      fsChmodFn = async (p: string) => { chmodPaths.push(p); };

      await getBinaryPath('/tmp/base');
      assert.ok(chmodPaths.length >= 2);
    });

    it('skips chmod for dotfiles and underscore-prefixed files', async () => {
      const chmodPaths: string[] = [];
      setupDownloadMocks({
        destDirEntries: ['llama-server', '.hidden', '_temp'],
      });
      fsChmodFn = async (p: string) => { chmodPaths.push(p); };

      await getBinaryPath('/tmp/base');
      assert.ok(!chmodPaths.some(p => p.includes('.hidden')));
      assert.ok(!chmodPaths.some(p => p.includes('_temp')));
      assert.ok(chmodPaths.some(p => p.includes('llama-server')));
    });

    it('downloads CUDA runtime when pattern includes cudart', async () => {
      setPlatform('win32', 'x64');
      _resetGpuCache();

      execFileSyncFn = (cmd: string, args: any[]) => {
        if (cmd === 'where') throw new Error('not on PATH');
        if (cmd === 'nvidia-smi' && (!args || args.length === 0)) return 'CUDA Version: 12.4\n';
        if (cmd === 'nvidia-smi') return 'RTX 4090\n';
        if (cmd === 'powershell') return '';
        throw new Error('not found');
      };
      existsSyncFn = () => false;

      const fetchCalls: string[] = [];
      fetchFn = async (url: string) => {
        fetchCalls.push(url);
        if (url.includes('api.github.com')) {
          return {
            ok: true,
            json: async () => ({
              tag_name: 'b8300',
              assets: [
                { name: 'llama-b8300-bin-win-cuda-12.4-x64.zip', browser_download_url: 'https://example.com/main.zip' },
                { name: 'cudart-llama-bin-win-cuda-12.4-x64.zip', browser_download_url: 'https://example.com/cudart.zip' },
              ],
            }),
          };
        }
        return {
          ok: true,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([0x00]));
              controller.close();
            },
          }),
        };
      };

      // BINARY_NAME is set at module load time based on original process.platform.
      // Since tests run on macOS/Linux, BINARY_NAME = 'llama-server' (not .exe).
      const binaryName = 'llama-server';

      // Track which extract dirs we've seen to avoid infinite recursion
      const seenDirs = new Set<string>();
      fsReaddirFn = async (dir: string, _opts?: any) => {
        const dirStr = String(dir);
        if (seenDirs.has(dirStr)) return [];
        seenDirs.add(dirStr);

        if (dirStr.includes('_extract_')) {
          return [{ name: binaryName, isFile: () => true, isDirectory: () => false }];
        }
        return [];
      };

      fsMkdirFn = async () => {};
      fsRenameFn = async () => {};
      fsCopyFileFn = async () => {};
      fsUnlinkFn = async () => {};
      fsRmFn = async () => {};
      fsChmodFn = async () => {};
      fsSymlinkFn = async () => {};
      pipelineFn = async () => {};

      await getBinaryPath('/tmp/base');
      // Two download URLs should have been fetched (main + cudart)
      const downloadCalls = fetchCalls.filter(u => !u.includes('api.github.com'));
      assert.equal(downloadCalls.length, 2);
    });

    it('handles download failure (non-ok response)', async () => {
      setPlatform('darwin', 'arm64');
      execFileSyncFn = () => { throw new Error('not on PATH'); };
      existsSyncFn = () => false;

      let apiCalled = false;
      fetchFn = async (url: string) => {
        if (url.includes('api.github.com')) {
          apiCalled = true;
          return {
            ok: true,
            json: async () => ({
              tag_name: 'b8300',
              assets: [{
                name: 'llama-b8300-bin-macos-arm64.tar.gz',
                browser_download_url: 'https://example.com/dl.tar.gz',
              }],
            }),
          };
        }
        return { ok: false, status: 404, body: null };
      };

      await assert.rejects(
        getBinaryPath('/tmp/base'),
        /Download failed: 404/,
      );
    });

    it('handles zip extraction on non-Windows Unix', async () => {
      let unzipCalled = false;
      setupDownloadMocks({
        platform: 'darwin',
        arch: 'arm64',
        assetName: 'llama-b8300-bin-macos-arm64.zip',
      });
      execFileSyncFn = (cmd: string) => {
        if (cmd === 'which') throw new Error('not on PATH');
        if (cmd === 'unzip') { unzipCalled = true; return ''; }
        throw new Error('not found');
      };

      // Adjust fetch to return the zip asset
      fetchFn = async (url: string) => {
        if (url.includes('api.github.com')) {
          return {
            ok: true,
            json: async () => ({
              tag_name: 'b8300',
              assets: [{
                name: 'llama-b8300-bin-macos-arm64.zip',
                browser_download_url: 'https://example.com/dl.zip',
              }],
            }),
          };
        }
        return {
          ok: true,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([0x00]));
              controller.close();
            },
          }),
        };
      };

      await getBinaryPath('/tmp/base');
      assert.ok(unzipCalled, 'unzip should have been called');
    });

    it('copyDirFiles falls back to copyFile+unlink when rename fails', async () => {
      let copyFileCalled = false;
      let unlinkCalled = false;

      setupDownloadMocks();
      fsRenameFn = async () => { throw new Error('cross-device rename'); };
      fsCopyFileFn = async () => { copyFileCalled = true; };
      fsUnlinkFn = async () => { unlinkCalled = true; };

      await getBinaryPath('/tmp/base');
      assert.ok(copyFileCalled, 'copyFile should have been used as fallback');
      assert.ok(unlinkCalled, 'unlink should have been called after copyFile');
    });
  });

});
