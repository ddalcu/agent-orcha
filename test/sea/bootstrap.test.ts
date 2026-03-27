import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import * as path from 'path';

// ─── Mock state ─────────────────────────────────────────────────────────────

let fsMock: Record<string, (...args: any[]) => any>;

// Mock `fs` module before importing the module under test
mock.module('fs', {
  namedExports: {
    existsSync: (...args: any[]) => fsMock.existsSync(...args),
    readFileSync: (...args: any[]) => fsMock.readFileSync(...args),
    writeFileSync: (...args: any[]) => fsMock.writeFileSync(...args),
    mkdirSync: (...args: any[]) => fsMock.mkdirSync(...args),
    rmSync: (...args: any[]) => fsMock.rmSync(...args),
    statSync: (...args: any[]) => fsMock.statSync(...args),
    readdirSync: (...args: any[]) => fsMock.readdirSync(...args),
    chmodSync: (...args: any[]) => fsMock.chmodSync(...args),
    cpSync: (...args: any[]) => fsMock.cpSync(...args),
    copyFileSync: (...args: any[]) => fsMock.copyFileSync(...args),
  },
});

// Import the module under test after mocks
const {
  isSea,
  getDefaultWorkspace,
  getOrchaDir,
  getPublicDir,
  getSqliteVecPath,
  seaBootstrap,
  extractTemplates,
  resolveWorkspace,
  scaffoldWorkspace,
  _resetSeaCache,
  _setSeaMock,
} = await import('../../lib/sea/bootstrap.ts');

const ORCHA_DIR = getOrchaDir();
const DEFAULT_WORKSPACE = path.join(ORCHA_DIR, 'workspace');

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('sea/bootstrap', () => {
  let logCalls: string[];

  beforeEach(() => {
    _resetSeaCache();

    logCalls = [];
    mock.method(console, 'log', (...args: any[]) => {
      logCalls.push(args.join(' '));
    });

    // Default fs mock — everything is a no-op / not found
    fsMock = {
      existsSync: () => false,
      readFileSync: () => '',
      writeFileSync: () => {},
      mkdirSync: () => {},
      rmSync: () => {},
      statSync: () => ({ size: 1000, mtimeMs: 12345 }),
      readdirSync: () => [],
      chmodSync: () => {},
      cpSync: () => {},
      copyFileSync: () => {},
    };
  });

  afterEach(() => {
    _resetSeaCache();
    mock.restoreAll();
  });

  // ─── getDefaultWorkspace ──────────────────────────────────────────────────

  describe('getDefaultWorkspace', () => {
    it('returns the expected default workspace path', () => {
      assert.strictEqual(getDefaultWorkspace(), DEFAULT_WORKSPACE);
    });
  });

  // ─── getPublicDir ─────────────────────────────────────────────────────────

  describe('getPublicDir', () => {
    it('returns public dir under ORCHA_DIR', () => {
      assert.strictEqual(getPublicDir(), path.join(ORCHA_DIR, 'public'));
    });
  });

  // ─── getSqliteVecPath ─────────────────────────────────────────────────────

  describe('getSqliteVecPath', () => {
    it('returns correct extension for current platform', () => {
      const result = getSqliteVecPath();
      const ext = process.platform === 'win32' ? 'dll'
        : process.platform === 'darwin' ? 'dylib' : 'so';
      assert.strictEqual(result, path.join(ORCHA_DIR, 'native', `vec0.${ext}`));
    });
  });

  // ─── isSea ────────────────────────────────────────────────────────────────

  describe('isSea', () => {
    it('returns false when not running as SEA', () => {
      assert.strictEqual(isSea(), false);
    });

    it('caches the result on subsequent calls', () => {
      const first = isSea();
      const second = isSea();
      assert.strictEqual(first, second);
      assert.strictEqual(first, false);
    });

    it('returns true when SEA module reports isSea true', () => {
      _setSeaMock({ isSea: () => true });
      // _isSea is still null, so isSea() will call sea().isSea()
      assert.strictEqual(isSea(), true);
    });
  });

  // ─── seaBootstrap ─────────────────────────────────────────────────────────

  describe('seaBootstrap', () => {
    it('no-ops when not running as SEA', () => {
      let mkdirCalled = false;
      fsMock.mkdirSync = () => { mkdirCalled = true; };

      seaBootstrap();

      assert.strictEqual(mkdirCalled, false);
      assert.strictEqual(logCalls.length, 0);
    });

    it('extracts public/ and native/ assets when signature has changed', () => {
      const writtenFiles: Array<{ path: string; data: any }> = [];
      const chmodPaths: string[] = [];

      const mockSeaMod = {
        isSea: () => true,
        getAsset: (key: string) => {
          if (key === 'version') return '1.0.0';
          return '';
        },
        getAssetKeys: () => [
          'version',
          'public/index.html',
          'public/app.js',
          'native/vec0.dylib',
          'templates/agent.yaml',  // should be skipped by seaBootstrap
          'other/skip.txt',        // should be skipped
        ],
        getRawAsset: () => new ArrayBuffer(10),
      };

      _setSeaMock(mockSeaMod);

      fsMock.existsSync = (p: string) => {
        if (typeof p === 'string' && p.includes('.signature')) return true;
        if (typeof p === 'string' && p.includes('native')) return true;
        return false;
      };
      fsMock.readFileSync = (p: string) => {
        if (typeof p === 'string' && p.includes('.signature')) return 'old-signature';
        return '';
      };
      fsMock.statSync = () => ({ size: 2000, mtimeMs: 99999 }); // Different from 'old-signature'
      fsMock.writeFileSync = (p: string, data: any) => {
        writtenFiles.push({ path: p, data });
      };
      fsMock.mkdirSync = () => {};
      fsMock.readdirSync = () => ['vec0.dylib'];
      fsMock.chmodSync = (p: string) => { chmodPaths.push(p); };

      seaBootstrap();

      const extractedPaths = writtenFiles.map(f => f.path);
      assert.ok(extractedPaths.some(p => p.includes('public') && p.includes('index.html')),
        'Should extract public/index.html');
      assert.ok(extractedPaths.some(p => p.includes('public') && p.includes('app.js')),
        'Should extract public/app.js');
      assert.ok(extractedPaths.some(p => p.includes('native') && p.includes('vec0.dylib')),
        'Should extract native/vec0.dylib');
      assert.ok(!extractedPaths.some(p => p.includes('templates')),
        'Should not extract templates/');
      assert.ok(!extractedPaths.some(p => p.includes('other')),
        'Should not extract other/');

      // Should have written signature file
      assert.ok(extractedPaths.some(p => p.includes('.signature')),
        'Should write signature');

      // Should have logged messages
      assert.ok(logCalls.some(l => l.includes('Updating')),
        'Should log updating message');
      assert.ok(logCalls.some(l => l.includes('updated')),
        'Should log updated message');

      // On non-Windows, should chmod native files
      if (process.platform !== 'win32') {
        assert.ok(chmodPaths.length > 0, 'Should chmod native files');
      }
    });

    it('skips extraction when signature matches', () => {
      const mockSeaMod = {
        isSea: () => true,
        getAsset: () => '1.0.0',
        getAssetKeys: () => ['version'],
        getRawAsset: () => new ArrayBuffer(0),
      };

      _setSeaMock(mockSeaMod);

      const signature = '2000:99999';
      fsMock.existsSync = (p: string) => {
        if (typeof p === 'string' && p.includes('.signature')) return true;
        return false;
      };
      fsMock.readFileSync = (p: string) => {
        if (typeof p === 'string' && p.includes('.signature')) return signature;
        return '';
      };
      fsMock.statSync = () => ({ size: 2000, mtimeMs: 99999 });

      let writeCalled = false;
      fsMock.writeFileSync = () => { writeCalled = true; };

      seaBootstrap();

      assert.strictEqual(writeCalled, false, 'Should not write files when signature matches');
      assert.strictEqual(logCalls.length, 0, 'Should not log when signature matches');
    });

    it('handles first run when no signature file exists', () => {
      const writtenFiles: string[] = [];
      const mockSeaMod = {
        isSea: () => true,
        getAsset: () => '1.0.0',
        getAssetKeys: () => ['version', 'public/test.js'],
        getRawAsset: () => new ArrayBuffer(5),
      };

      _setSeaMock(mockSeaMod);

      fsMock.existsSync = () => false;
      fsMock.statSync = () => ({ size: 3000, mtimeMs: 11111 });
      fsMock.writeFileSync = (p: string) => { writtenFiles.push(p); };
      fsMock.mkdirSync = () => {};

      seaBootstrap();

      assert.ok(writtenFiles.some(p => p.includes('test.js')),
        'Should extract assets on first run');
      assert.ok(writtenFiles.some(p => p.includes('.signature')),
        'Should create signature file');
    });

    it('skips chmod on Windows', () => {
      // This test verifies the platform branch; on macOS/Linux it tests the non-win32 path
      const chmodPaths: string[] = [];
      const mockSeaMod = {
        isSea: () => true,
        getAsset: () => '1.0.0',
        getAssetKeys: () => ['version', 'native/lib.dylib'],
        getRawAsset: () => new ArrayBuffer(5),
      };

      _setSeaMock(mockSeaMod);

      fsMock.existsSync = (p: string) => {
        if (typeof p === 'string' && p.includes('native')) return true;
        return false;
      };
      fsMock.readFileSync = () => 'different';
      fsMock.statSync = () => ({ size: 5000, mtimeMs: 55555 });
      fsMock.writeFileSync = () => {};
      fsMock.mkdirSync = () => {};
      fsMock.readdirSync = () => ['lib.dylib'];
      fsMock.chmodSync = (p: string) => { chmodPaths.push(p); };

      seaBootstrap();

      if (process.platform === 'win32') {
        assert.strictEqual(chmodPaths.length, 0, 'Should not chmod on Windows');
      } else {
        assert.ok(chmodPaths.length > 0, 'Should chmod on non-Windows');
      }
    });

    it('skips version key during extraction', () => {
      const writtenPaths: string[] = [];
      const mockSeaMod = {
        isSea: () => true,
        getAsset: () => '2.0.0',
        getAssetKeys: () => ['version', 'public/file.js'],
        getRawAsset: () => new ArrayBuffer(3),
      };

      _setSeaMock(mockSeaMod);

      fsMock.existsSync = () => false;
      fsMock.statSync = () => ({ size: 7000, mtimeMs: 77777 });
      fsMock.writeFileSync = (p: string) => { writtenPaths.push(p); };
      fsMock.mkdirSync = () => {};

      seaBootstrap();

      // 'version' key should not produce a file write to a 'version' path
      // (it's used for the log message, not extracted as a file)
      const versionWrites = writtenPaths.filter(p =>
        !p.includes('.signature') && !p.includes('public') && !p.includes('native')
      );
      assert.strictEqual(versionWrites.length, 0,
        'Should not write a file for the version key');
    });
  });

  // ─── extractTemplates ─────────────────────────────────────────────────────

  describe('extractTemplates', () => {
    it('skips non-template keys', () => {
      const writtenPaths: string[] = [];
      const mockSeaMod = {
        isSea: () => true,
        getAssetKeys: () => ['version', 'public/index.html', 'native/lib.so', 'templates/real.yaml'],
        getRawAsset: () => new ArrayBuffer(5),
      };

      _setSeaMock(mockSeaMod);

      fsMock.writeFileSync = (p: string) => { writtenPaths.push(p); };
      fsMock.mkdirSync = () => {};

      extractTemplates('/out');

      assert.strictEqual(writtenPaths.length, 1, 'Should only extract templates/ prefixed keys');
      assert.ok(writtenPaths[0]!.endsWith('real.yaml'));
    });

    it('extracts only templates/ prefixed assets', () => {
      const writtenFiles: Array<{ path: string }> = [];
      const mkdirs: string[] = [];

      const mockSeaMod = {
        isSea: () => true,
        getAssetKeys: () => [
          'version',
          'public/index.html',
          'templates/agent.yaml',
          'templates/skills/builder/SKILL.md',
          'native/vec0.dylib',
        ],
        getRawAsset: () => new ArrayBuffer(10),
      };

      _setSeaMock(mockSeaMod);

      fsMock.writeFileSync = (p: string) => { writtenFiles.push({ path: p }); };
      fsMock.mkdirSync = (p: string) => { mkdirs.push(p); };

      const targetDir = '/tmp/test-templates';
      extractTemplates(targetDir);

      const paths = writtenFiles.map(f => f.path);
      assert.strictEqual(paths.length, 2, 'Should extract exactly 2 template files');
      assert.ok(paths.some(p => p === path.join(targetDir, 'agent.yaml')),
        'Should extract agent.yaml');
      assert.ok(
        paths.some(p => p === path.join(targetDir, 'skills/builder/SKILL.md')),
        'Should extract SKILL.md preserving subdirectory'
      );
    });

    it('creates parent directories for nested templates', () => {
      const mkdirs: string[] = [];

      const mockSeaMod = {
        isSea: () => true,
        getAssetKeys: () => ['templates/deep/nested/file.yaml'],
        getRawAsset: () => new ArrayBuffer(5),
      };

      _setSeaMock(mockSeaMod);

      fsMock.mkdirSync = (p: string) => { mkdirs.push(p); };
      fsMock.writeFileSync = () => {};

      extractTemplates('/target');

      assert.ok(
        mkdirs.some(d => d === path.join('/target', 'deep/nested')),
        'Should create nested parent directories'
      );
    });

    it('strips templates/ prefix from output paths', () => {
      const writtenPaths: string[] = [];

      const mockSeaMod = {
        isSea: () => true,
        getAssetKeys: () => ['templates/my-template.yaml'],
        getRawAsset: () => new ArrayBuffer(3),
      };

      _setSeaMock(mockSeaMod);

      fsMock.writeFileSync = (p: string) => { writtenPaths.push(p); };
      fsMock.mkdirSync = () => {};

      extractTemplates('/out');

      assert.strictEqual(writtenPaths.length, 1);
      assert.strictEqual(writtenPaths[0], path.join('/out', 'my-template.yaml'));
    });
  });

  // ─── resolveWorkspace ────────────────────────────────────────────────────

  describe('resolveWorkspace', () => {
    it('returns WORKSPACE env var when set', () => {
      const original = process.env.WORKSPACE;
      try {
        process.env.WORKSPACE = '/custom/workspace';
        assert.strictEqual(resolveWorkspace(), '/custom/workspace');
      } finally {
        if (original === undefined) delete process.env.WORKSPACE;
        else process.env.WORKSPACE = original;
      }
    });

    it('returns default workspace when WORKSPACE env var is not set', () => {
      const original = process.env.WORKSPACE;
      try {
        delete process.env.WORKSPACE;
        assert.strictEqual(resolveWorkspace(), DEFAULT_WORKSPACE);
      } finally {
        if (original !== undefined) process.env.WORKSPACE = original;
      }
    });
  });

  // ─── scaffoldWorkspace ───────────────────────────────────────────────────

  describe('scaffoldWorkspace', () => {
    it('skips scaffolding when agents/ directory already exists', () => {
      let mkdirCalled = false;
      fsMock.existsSync = (p: string) => {
        if (typeof p === 'string' && p.endsWith('agents')) return true;
        return false;
      };
      fsMock.mkdirSync = () => { mkdirCalled = true; };

      scaffoldWorkspace('/some/workspace');

      assert.strictEqual(mkdirCalled, false, 'Should not create directories when agents/ exists');
      assert.strictEqual(logCalls.length, 0, 'Should not log when workspace already exists');
    });

    it('scaffolds workspace in SEA mode using extractTemplates', () => {
      const writtenPaths: string[] = [];
      const mockSeaMod = {
        isSea: () => true,
        getAssetKeys: () => ['templates/agents/test.yaml'],
        getRawAsset: () => new ArrayBuffer(5),
      };

      _setSeaMock(mockSeaMod);

      fsMock.existsSync = () => false;
      fsMock.mkdirSync = () => {};
      fsMock.writeFileSync = (p: string) => { writtenPaths.push(p); };

      scaffoldWorkspace('/test/workspace');

      assert.ok(logCalls.some(l => l.includes('Creating workspace')), 'Should log creation message');
      assert.ok(logCalls.some(l => l.includes('Workspace created')), 'Should log completion');
      assert.ok(writtenPaths.length > 0, 'Should extract template files');
    });
  });
});
