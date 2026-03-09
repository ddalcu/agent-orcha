import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  detectGpu,
  _getAssetPatterns,
  _getBinaryDirName,
  _resetGpuCache,
  type GpuInfo,
  type _Platform,
} from '../../lib/local-llm/binary-manager.ts';

const gpu = (accel: GpuInfo['accel'], name?: string): GpuInfo => ({ accel, name });

describe('binary-manager', () => {
  // ─── Asset Pattern Selection ────────────────────────────────────────────────
  // These tests verify the correct binary is selected for every platform × GPU combo.

  describe('getAssetPatterns — Windows', () => {
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

    it('NVIDIA + old CUDA driver → vulkan binary, no cudart', () => {
      const p = _getAssetPatterns(platform, gpu('vulkan', 'GTX 1080'));
      assert.equal(p.main, 'bin-win-vulkan-x64');
      assert.equal(p.cudart, undefined);
    });

    it('AMD GPU → vulkan binary, no cudart', () => {
      const p = _getAssetPatterns(platform, gpu('vulkan', 'AMD Radeon RX 7900'));
      assert.equal(p.main, 'bin-win-vulkan-x64');
      assert.equal(p.cudart, undefined);
    });

    it('Intel GPU → vulkan binary, no cudart', () => {
      const p = _getAssetPatterns(platform, gpu('vulkan', 'Intel Arc A770'));
      assert.equal(p.main, 'bin-win-vulkan-x64');
      assert.equal(p.cudart, undefined);
    });

    it('No GPU → CPU binary, no cudart', () => {
      const p = _getAssetPatterns(platform, gpu('none'));
      assert.equal(p.main, 'bin-win-cpu-x64');
      assert.equal(p.cudart, undefined);
    });
  });

  describe('getAssetPatterns — Linux', () => {
    const platform: _Platform = 'linux-x64';

    it('NVIDIA → vulkan binary', () => {
      const p = _getAssetPatterns(platform, gpu('vulkan', 'RTX 4090'));
      assert.equal(p.main, 'bin-ubuntu-vulkan-x64');
      assert.equal(p.cudart, undefined);
    });

    it('AMD GPU → vulkan binary', () => {
      const p = _getAssetPatterns(platform, gpu('vulkan', 'AMD Radeon'));
      assert.equal(p.main, 'bin-ubuntu-vulkan-x64');
      assert.equal(p.cudart, undefined);
    });

    it('Intel GPU → vulkan binary', () => {
      const p = _getAssetPatterns(platform, gpu('vulkan', 'Intel Arc'));
      assert.equal(p.main, 'bin-ubuntu-vulkan-x64');
      assert.equal(p.cudart, undefined);
    });

    it('No GPU → CPU binary', () => {
      const p = _getAssetPatterns(platform, gpu('none'));
      assert.equal(p.main, 'bin-ubuntu-x64');
      assert.equal(p.cudart, undefined);
    });
  });

  describe('getAssetPatterns — macOS', () => {
    it('arm64 → macos-arm64 binary', () => {
      const p = _getAssetPatterns('macos-arm64', gpu('metal'));
      assert.equal(p.main, 'bin-macos-arm64');
      assert.equal(p.cudart, undefined);
    });

    it('x64 → macos-x64 binary', () => {
      const p = _getAssetPatterns('macos-x64', gpu('metal'));
      assert.equal(p.main, 'bin-macos-x64');
      assert.equal(p.cudart, undefined);
    });
  });

  // ─── Asset Pattern Matching Against Real Release Names ──────────────────────
  // Verifies patterns actually match the naming convention used in llama.cpp releases.

  describe('asset pattern matching against release names', () => {
    // Real release asset names from llama.cpp (build number varies)
    const releaseAssets = [
      'llama-b8215-bin-macos-arm64.tar.gz',
      'llama-b8215-bin-macos-x64.tar.gz',
      'llama-b8215-bin-ubuntu-x64.tar.gz',
      'llama-b8215-bin-ubuntu-vulkan-x64.tar.gz',
      'llama-b8215-bin-ubuntu-rocm-7.2-x64.tar.gz',
      'llama-b8215-bin-win-cpu-x64.zip',
      'llama-b8215-bin-win-cuda-12.4-x64.zip',
      'llama-b8215-bin-win-cuda-13.1-x64.zip',
      'llama-b8215-bin-win-vulkan-x64.zip',
      'llama-b8215-bin-win-hip-radeon-x64.zip',
      'llama-b8215-bin-win-sycl-x64.zip',
      'cudart-llama-bin-win-cuda-12.4-x64.zip',
      'cudart-llama-bin-win-cuda-13.1-x64.zip',
    ];

    function findAsset(pattern: string, excludeCudart = true) {
      return releaseAssets.find(name =>
        name.includes(pattern) && (!excludeCudart || !name.startsWith('cudart'))
      );
    }

    it('Windows CUDA 12.4 main asset matches exactly one release', () => {
      const p = _getAssetPatterns('win-x64', gpu('cuda-12.4'));
      const match = findAsset(p.main);
      assert.equal(match, 'llama-b8215-bin-win-cuda-12.4-x64.zip');
    });

    it('Windows CUDA 12.4 cudart matches exactly one release', () => {
      const p = _getAssetPatterns('win-x64', gpu('cuda-12.4'));
      const match = releaseAssets.find(name => name.includes(p.cudart!));
      assert.equal(match, 'cudart-llama-bin-win-cuda-12.4-x64.zip');
    });

    it('Windows CUDA 13.1 main asset matches exactly one release', () => {
      const p = _getAssetPatterns('win-x64', gpu('cuda-13.1'));
      const match = findAsset(p.main);
      assert.equal(match, 'llama-b8215-bin-win-cuda-13.1-x64.zip');
    });

    it('Windows CUDA 13.1 cudart matches exactly one release', () => {
      const p = _getAssetPatterns('win-x64', gpu('cuda-13.1'));
      const match = releaseAssets.find(name => name.includes(p.cudart!));
      assert.equal(match, 'cudart-llama-bin-win-cuda-13.1-x64.zip');
    });

    it('Windows CUDA main pattern does NOT match cudart assets', () => {
      const p = _getAssetPatterns('win-x64', gpu('cuda-12.4'));
      const matches = releaseAssets.filter(name =>
        name.includes(p.main) && !name.startsWith('cudart')
      );
      assert.equal(matches.length, 1);
    });

    it('Windows Vulkan matches exactly one release', () => {
      const p = _getAssetPatterns('win-x64', gpu('vulkan'));
      const match = findAsset(p.main);
      assert.equal(match, 'llama-b8215-bin-win-vulkan-x64.zip');
    });

    it('Windows CPU matches exactly one release', () => {
      const p = _getAssetPatterns('win-x64', gpu('none'));
      const match = findAsset(p.main);
      assert.equal(match, 'llama-b8215-bin-win-cpu-x64.zip');
    });

    it('Linux Vulkan matches exactly one release', () => {
      const p = _getAssetPatterns('linux-x64', gpu('vulkan'));
      const match = findAsset(p.main);
      assert.equal(match, 'llama-b8215-bin-ubuntu-vulkan-x64.tar.gz');
    });

    it('Linux CPU matches exactly one release', () => {
      const p = _getAssetPatterns('linux-x64', gpu('none'));
      const match = findAsset(p.main);
      assert.equal(match, 'llama-b8215-bin-ubuntu-x64.tar.gz');
    });

    it('macOS arm64 matches exactly one release', () => {
      const p = _getAssetPatterns('macos-arm64', gpu('metal'));
      const match = findAsset(p.main);
      assert.equal(match, 'llama-b8215-bin-macos-arm64.tar.gz');
    });

    it('macOS x64 matches exactly one release', () => {
      const p = _getAssetPatterns('macos-x64', gpu('metal'));
      const match = findAsset(p.main);
      assert.equal(match, 'llama-b8215-bin-macos-x64.tar.gz');
    });
  });

  // ─── Binary Cache Directories ──────────────────────────────────────────────

  describe('getBinaryDirName', () => {
    it('Windows + CUDA 12.4 → win-cuda-12.4-x64', () => {
      assert.equal(_getBinaryDirName('win-x64', gpu('cuda-12.4')), 'win-cuda-12.4-x64');
    });

    it('Windows + CUDA 13.1 → win-cuda-13.1-x64', () => {
      assert.equal(_getBinaryDirName('win-x64', gpu('cuda-13.1')), 'win-cuda-13.1-x64');
    });

    it('Windows + Vulkan → win-vulkan-x64', () => {
      assert.equal(_getBinaryDirName('win-x64', gpu('vulkan')), 'win-vulkan-x64');
    });

    it('Windows + no GPU → win-x64', () => {
      assert.equal(_getBinaryDirName('win-x64', gpu('none')), 'win-x64');
    });

    it('Linux + Vulkan → linux-vulkan-x64', () => {
      assert.equal(_getBinaryDirName('linux-x64', gpu('vulkan')), 'linux-vulkan-x64');
    });

    it('Linux + no GPU → linux-x64', () => {
      assert.equal(_getBinaryDirName('linux-x64', gpu('none')), 'linux-x64');
    });

    it('macOS arm64 always → macos-arm64', () => {
      assert.equal(_getBinaryDirName('macos-arm64', gpu('metal')), 'macos-arm64');
    });

    it('macOS x64 always → macos-x64', () => {
      assert.equal(_getBinaryDirName('macos-x64', gpu('metal')), 'macos-x64');
    });

    it('different GPU accel types produce different directories (no collisions)', () => {
      const dirs = new Set([
        _getBinaryDirName('win-x64', gpu('none')),
        _getBinaryDirName('win-x64', gpu('cuda-12.4')),
        _getBinaryDirName('win-x64', gpu('cuda-13.1')),
        _getBinaryDirName('win-x64', gpu('vulkan')),
      ]);
      assert.equal(dirs.size, 4);
    });
  });

  // ─── CUDA runtime is only bundled with CUDA builds ─────────────────────────

  describe('cudart bundling', () => {
    it('only CUDA builds include cudart pattern', () => {
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

  // ─── detectGpu behavior ────────────────────────────────────────────────────

  describe('detectGpu', () => {
    beforeEach(() => {
      _resetGpuCache();
    });

    it('returns a valid GpuInfo shape', () => {
      const info = detectGpu();
      assert.ok(['none', 'metal', 'cuda-12.4', 'cuda-13.1', 'vulkan'].includes(info.accel));
      assert.ok(typeof info.name === 'string' || info.name === undefined);
    });

    it('caches the result across calls', () => {
      const first = detectGpu();
      const second = detectGpu();
      assert.equal(first, second);
    });

    it('cache can be reset', () => {
      const first = detectGpu();
      _resetGpuCache();
      const second = detectGpu();
      // Same value but re-detected (not same reference due to new object)
      assert.deepEqual(first, second);
    });

    it('on macOS returns accel: metal', () => {
      if (process.platform !== 'darwin') return;
      const info = detectGpu();
      assert.equal(info.accel, 'metal');
    });
  });
});
