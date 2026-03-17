import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import { Writable } from 'stream';

// ── Mutable mock delegates ──

let execFileSyncFn: (cmd: string, args: string[], opts?: any) => string;
let spawnSyncFn: (cmd: string, args: string[], opts?: any) => any;
let existsSyncFn: (p: string) => boolean;
let fetchFn: (url: string, opts?: any) => Promise<any>;

// Track fs operations
let mkdirCalls: string[] = [];
let rmCalls: string[] = [];
let chmodCalls: string[] = [];
let readdirResults: Map<string, any[]> = new Map();

mock.module('child_process', {
  namedExports: {
    execFileSync: (cmd: string, args: string[], opts?: any) => execFileSyncFn(cmd, args, opts),
    spawnSync: (cmd: string, args: string[], opts?: any) => spawnSyncFn(cmd, args, opts),
  },
});

mock.module('fs', {
  namedExports: {
    existsSync: (p: string) => existsSyncFn(p),
    createWriteStream: () => {
      return new Writable({ write(_chunk: any, _enc: any, cb: any) { cb(); } });
    },
  },
});

mock.module('fs/promises', {
  namedExports: {
    mkdir: async (dir: string) => { mkdirCalls.push(dir); },
    rm: async (dir: string) => { rmCalls.push(dir); },
    unlink: async () => {},
    readdir: async (dir: string) => readdirResults.get(dir) || [],
    rename: async () => {},
    cp: async () => {},
    chmod: async (p: string) => { chmodCalls.push(p); },
  },
});

mock.module('stream/promises', {
  namedExports: {
    pipeline: async () => {},
  },
});

mock.module('../../lib/logger.ts', {
  namedExports: {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  },
});

// We need to mock global fetch
const originalFetch = globalThis.fetch;

const {
  getMlxBinaryPath,
  getMlxBinaryVersion,
  isMlxSystemBinary,
} = await import('../../lib/local-llm/mlx-binary-manager.ts');

describe('getMlxBinaryPath', () => {
  beforeEach(() => {
    execFileSyncFn = () => { throw new Error('not found'); };
    existsSyncFn = () => false;
  });

  it('should return system binary path when on PATH', async () => {
    execFileSyncFn = (cmd: string, args: string[]) => {
      if (cmd === 'which' && args[0] === 'mlx-serve') return '/usr/local/bin/mlx-serve';
      throw new Error('not found');
    };

    const result = await getMlxBinaryPath('/base');
    assert.strictEqual(result, '/usr/local/bin/mlx-serve');
  });

  it('should return local binary when already downloaded', async () => {
    execFileSyncFn = () => { throw new Error('not found'); };
    existsSyncFn = (p: string) => p.includes('.mlx-serve') && p.endsWith('mlx-serve');

    const result = await getMlxBinaryPath('/base');
    assert.ok(result.includes('.mlx-serve'));
    assert.ok(result.endsWith('mlx-serve'));
  });
});

describe('getMlxBinaryVersion', () => {
  beforeEach(() => {
    // Clear cached version by importing a fresh state
    // The module caches results, so we need to reset between tests
    execFileSyncFn = () => { throw new Error('not found'); };
    spawnSyncFn = () => ({ stdout: '', stderr: '' });
    existsSyncFn = () => false;
  });

  it('should return version from system binary', () => {
    execFileSyncFn = (cmd: string, args: string[]) => {
      if (cmd === 'which') return '/usr/local/bin/mlx-serve';
      throw new Error('not found');
    };
    spawnSyncFn = () => ({ stdout: 'mlx-serve 0.3.1', stderr: '' });

    // Use a unique baseDir to avoid cache hits
    const version = getMlxBinaryVersion('/unique-base-' + Date.now());
    assert.strictEqual(version, '0.3.1');
  });

  it('should return version from local binary when not on PATH', () => {
    execFileSyncFn = () => { throw new Error('not found'); };
    existsSyncFn = (p: string) => p.endsWith('mlx-serve');
    spawnSyncFn = () => ({ stdout: '0.4.0', stderr: '' });

    const version = getMlxBinaryVersion('/unique-local-' + Date.now());
    assert.strictEqual(version, '0.4.0');
  });

  it('should return null when no binary exists', () => {
    execFileSyncFn = () => { throw new Error('not found'); };
    existsSyncFn = () => false;

    const version = getMlxBinaryVersion('/unique-none-' + Date.now());
    assert.strictEqual(version, null);
  });

  it('should return null when version cannot be parsed', () => {
    execFileSyncFn = (cmd: string) => {
      if (cmd === 'which') return '/usr/local/bin/mlx-serve';
      throw new Error('not found');
    };
    spawnSyncFn = () => ({ stdout: 'no version here', stderr: '' });

    const version = getMlxBinaryVersion('/unique-noparse-' + Date.now());
    assert.strictEqual(version, null);
  });

  it('should use cached version on subsequent calls with same baseDir', () => {
    const uniqueDir = '/unique-cache-' + Date.now();
    execFileSyncFn = (cmd: string) => {
      if (cmd === 'which') return '/usr/local/bin/mlx-serve';
      throw new Error('not found');
    };
    spawnSyncFn = () => ({ stdout: '1.0.0', stderr: '' });

    const v1 = getMlxBinaryVersion(uniqueDir);
    assert.strictEqual(v1, '1.0.0');

    // Change the mock to return something different, but cache should be used
    spawnSyncFn = () => ({ stdout: '2.0.0', stderr: '' });
    const v2 = getMlxBinaryVersion(uniqueDir);
    assert.strictEqual(v2, '1.0.0'); // cached
  });

  it('should parse version from stderr', () => {
    execFileSyncFn = (cmd: string) => {
      if (cmd === 'which') return '/usr/local/bin/mlx-serve';
      throw new Error('not found');
    };
    spawnSyncFn = () => ({ stdout: '', stderr: 'mlx-serve version 0.5.2' });

    const version = getMlxBinaryVersion('/unique-stderr-' + Date.now());
    assert.strictEqual(version, '0.5.2');
  });
});

describe('isMlxSystemBinary', () => {
  // Note: isMlxSystemBinary uses a module-level cache (cachedIsMlxSystem).
  // The first call sets it and subsequent calls return cached value.
  // We can only test the first call behavior in isolation.

  it('should return a boolean', () => {
    const result = isMlxSystemBinary();
    assert.strictEqual(typeof result, 'boolean');
  });
});


describe('getMlxBinaryPath — download path', () => {
  beforeEach(() => {
    mkdirCalls = [];
    rmCalls = [];
    chmodCalls = [];
    readdirResults = new Map();
  });

  it('should download binary when not on PATH and not already downloaded', async () => {
    execFileSyncFn = (cmd: string, args: string[]) => {
      if (cmd === 'which') throw new Error('not found');
      // tar extraction is a no-op in mock
      return '';
    };
    existsSyncFn = () => false;

    readdirResults = new Map();

    // Mock fetch for GitHub API and binary download
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url: string) => {
      if (typeof url === 'string' && url.includes('github.com/repos')) {
        return {
          ok: true,
          json: async () => ({
            assets: [{
              name: 'mlx-serve-bin-macos-arm64.tar.gz',
              browser_download_url: 'https://example.com/download.tar.gz',
            }],
          }),
        } as any;
      }
      // Download response — must return a web ReadableStream for Readable.fromWeb()
      const body = new ReadableStream({
        start(controller) { controller.close(); },
      });
      return { ok: true, body } as any;
    };

    // The mock readdir returns empty arrays (no matching entries in map),
    // so findFileRecursive won't find the binary -> throws "not found in archive"
    await assert.rejects(
      () => getMlxBinaryPath('/base-download-' + Date.now()),
      /mlx-serve binary not found in archive/
    );

    // Verify mkdir was called (destDir was created)
    assert.ok(mkdirCalls.length > 0, 'mkdir should have been called');

    globalThis.fetch = origFetch;
  });

  it('should throw when GitHub API returns non-OK', async () => {
    execFileSyncFn = () => { throw new Error('not found'); };
    existsSyncFn = () => false;

    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 403 }) as any;

    await assert.rejects(
      () => getMlxBinaryPath('/base-apierr-' + Date.now()),
      /GitHub API error: 403/
    );

    globalThis.fetch = origFetch;
  });

  it('should throw when no matching asset in release', async () => {
    execFileSyncFn = () => { throw new Error('not found'); };
    existsSyncFn = () => false;

    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ assets: [{ name: 'some-other-binary.tar.gz' }] }),
    }) as any;

    await assert.rejects(
      () => getMlxBinaryPath('/base-noasset-' + Date.now()),
      /No mlx-serve binary found for macOS ARM64/
    );

    globalThis.fetch = origFetch;
  });

  it('should throw when download response is not OK', async () => {
    execFileSyncFn = () => { throw new Error('not found'); };
    existsSyncFn = () => false;

    const origFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: true,
          json: async () => ({
            assets: [{
              name: 'mlx-serve-bin-macos-arm64.tar.gz',
              browser_download_url: 'https://example.com/download.tar.gz',
            }],
          }),
        } as any;
      }
      return { ok: false, status: 500 } as any;
    };

    await assert.rejects(
      () => getMlxBinaryPath('/base-dlerr-' + Date.now()),
      /Download failed: 500/
    );

    globalThis.fetch = origFetch;
  });
});


describe('isMlxSystemBinary — cache behavior', () => {
  it('should return cached value on subsequent calls', () => {
    // First call already ran in previous describe block, so cache is set
    const result1 = isMlxSystemBinary();
    const result2 = isMlxSystemBinary();
    assert.strictEqual(result1, result2);
  });
});

describe('getMlxBinaryVersion — parseVersion error handling', () => {
  it('should return null when spawnSync throws', () => {
    execFileSyncFn = (cmd: string) => {
      if (cmd === 'which') return '/usr/local/bin/mlx-serve';
      throw new Error('not found');
    };
    spawnSyncFn = () => { throw new Error('spawn failed'); };

    const version = getMlxBinaryVersion('/unique-spawnerr-' + Date.now());
    assert.strictEqual(version, null);
  });
});
