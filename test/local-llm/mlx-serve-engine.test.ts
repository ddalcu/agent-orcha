import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';

// ── Mutable mock delegates ──

let getMlxBinaryVersionFn: (dir: string) => string | null;
let isMlxSystemBinaryFn: () => boolean;
let killOrphanedMlxServersFn: (dir: string) => void;
let fetchFn: (url: string) => Promise<any>;
let findModelFileFn: (name: string) => Promise<any>;

// Track instances
let mlxServerInstances: any[] = [];

// ── Module mocks ──

mock.module('../../lib/local-llm/mlx-binary-manager.ts', {
  namedExports: {
    getMlxBinaryVersion: (dir: string) => getMlxBinaryVersionFn(dir),
    isMlxSystemBinary: () => isMlxSystemBinaryFn(),
    getMlxBinaryPath: () => '/fake/mlx-serve',
  },
});

mock.module('../../lib/local-llm/binary-manager.ts', {
  namedExports: {
    getProcessMemory: () => null,
  },
});

mock.module('../../lib/local-llm/mlx-server-process.ts', {
  namedExports: {
    MlxServerProcess: class FakeMlxServerProcess {
      running = false;
      ready = false;
      modelPath: string | null = null;
      port: number | null = null;
      _baseDir: string;
      _role: string;

      constructor(baseDir: string, role = 'chat') {
        this._baseDir = baseDir;
        this._role = role;
        mlxServerInstances.push(this);
      }

      async start(opts: any) {
        this.running = true;
        this.ready = true;
        this.modelPath = opts.modelPath;
        this.port = 9090;
      }

      async stop() {
        this.running = false;
        this.ready = false;
      }

      getBaseUrl() {
        return `http://127.0.0.1:${this.port}`;
      }
    },
    killOrphanedMlxServers: (dir: string) => killOrphanedMlxServersFn(dir),
  },
});

mock.module('../../lib/local-llm/model-manager.ts', {
  namedExports: {
    ModelManager: class FakeModelManager {
      constructor() {}
      async findModelFile(name: string) {
        return findModelFileFn(name);
      }
    },
  },
});

mock.module('../../lib/logger.ts', {
  namedExports: {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  },
});

// ── Import after mocks ──

const { MlxServeEngine } = await import('../../lib/local-llm/engines/mlx-serve-engine.ts');

// Save original platform/arch
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const originalArch = Object.getOwnPropertyDescriptor(process, 'arch');

function setPlatform(platform: string, arch: string) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
}

function restorePlatform() {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  if (originalArch) Object.defineProperty(process, 'arch', originalArch);
}

describe('MlxServeEngine', () => {
  let engine: InstanceType<typeof MlxServeEngine>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mlxServerInstances = [];
    getMlxBinaryVersionFn = () => '1.0.0';
    isMlxSystemBinaryFn = () => false;
    killOrphanedMlxServersFn = () => {};
    fetchFn = async () => ({ ok: false });
    findModelFileFn = async (name: string) => ({ filePath: `/models/${name}`, type: 'mlx' as const });

    // Mock global fetch
    globalThis.fetch = (async (url: string) => fetchFn(url)) as any;

    restorePlatform();
    engine = new MlxServeEngine();
    engine.setBaseDir('/test/base');
  });

  // Restore after all
  afterEach(() => {
    globalThis.fetch = originalFetch;
    restorePlatform();
  });

  describe('engineName', () => {
    it('should be "mlx-serve"', () => {
      assert.strictEqual(engine.engineName, 'mlx-serve');
    });
  });

  describe('setBaseDir', () => {
    it('should set the base directory', () => {
      engine.setBaseDir('/new/dir');
      let passedDir: string | undefined;
      getMlxBinaryVersionFn = (dir) => { passedDir = dir; return '1.0.0'; };
      engine.isAvailable();
      assert.strictEqual(passedDir, '/new/dir');
    });
  });

  describe('isAvailable', () => {
    it('should return true on darwin arm64 with binary', () => {
      setPlatform('darwin', 'arm64');
      getMlxBinaryVersionFn = () => '1.0.0';
      // Re-create engine after platform change
      const e = new MlxServeEngine();
      e.setBaseDir('/test/base');
      assert.strictEqual(e.isAvailable(), true);
    });

    it('should return false when no binary', () => {
      setPlatform('darwin', 'arm64');
      getMlxBinaryVersionFn = () => null;
      const e = new MlxServeEngine();
      e.setBaseDir('/test/base');
      assert.strictEqual(e.isAvailable(), false);
    });

    it('should return false on linux', () => {
      setPlatform('linux', 'x64');
      getMlxBinaryVersionFn = () => '1.0.0';
      const e = new MlxServeEngine();
      e.setBaseDir('/test/base');
      assert.strictEqual(e.isAvailable(), false);
    });

    it('should return false on darwin x64 (Intel)', () => {
      setPlatform('darwin', 'x64');
      getMlxBinaryVersionFn = () => '1.0.0';
      const e = new MlxServeEngine();
      e.setBaseDir('/test/base');
      assert.strictEqual(e.isAvailable(), false);
    });
  });

  // ─── Chat ───────────────────────────────────────────────────────────────────

  describe('loadChat', () => {
    it('should start the chat server', async () => {
      fetchFn = async () => ({ ok: false });
      await engine.loadChat('/models/test-mlx');
      const server = mlxServerInstances.find((s: any) => s._role === 'chat');
      assert.ok(server);
      assert.strictEqual(server.running, true);
      assert.strictEqual(server.modelPath, '/models/test-mlx');
    });

    it('should skip if same model already running', async () => {
      fetchFn = async () => ({ ok: false });
      await engine.loadChat('/models/test-mlx');
      const countBefore = mlxServerInstances.length;
      await engine.loadChat('/models/test-mlx');
      assert.strictEqual(mlxServerInstances.length, countBefore);
    });

    it('should fetch /props and set memory estimate', async () => {
      fetchFn = async () => ({
        ok: true,
        json: async () => ({
          default_generation_settings: { n_ctx: 4096 },
          model_info: {
            num_hidden_layers: 32,
            num_key_value_heads: 8,
            head_dim: 128,
          },
          memory: { active_bytes: 5000000 },
        }),
      });

      await engine.loadChat('/models/test-mlx');

      const status = engine.getChatStatus();
      assert.strictEqual(status.contextSize, 4096);
      assert.ok(status.memoryEstimate);
      assert.strictEqual(status.memoryEstimate!.modelBytes, 5000000);
      // kvCacheBytes = 32 * 2 * 8 * 128 * 2 * 4096
      const expectedKv = 32 * 2 * 8 * 128 * 2 * 4096;
      assert.strictEqual(status.memoryEstimate!.kvCacheBytes, expectedKv);
      assert.strictEqual(status.memoryEstimate!.totalBytes, 5000000 + expectedKv);
    });

    it('should use opts.contextSize over /props n_ctx', async () => {
      fetchFn = async () => ({
        ok: true,
        json: async () => ({
          default_generation_settings: { n_ctx: 4096 },
          model_info: {
            num_hidden_layers: 32,
            num_key_value_heads: 8,
            head_dim: 128,
          },
          memory: { active_bytes: 1000 },
        }),
      });

      await engine.loadChat('/models/test-mlx', { contextSize: 2048 });

      const status = engine.getChatStatus();
      assert.strictEqual(status.contextSize, 2048);
    });

    it('should handle /props fetch failure gracefully', async () => {
      fetchFn = async () => { throw new Error('network error'); };
      await engine.loadChat('/models/test-mlx');
      // Should not throw, memoryEstimate stays null
      assert.strictEqual(engine.getChatStatus().memoryEstimate, null);
    });

    it('should handle /props with no model_info', async () => {
      fetchFn = async () => ({
        ok: true,
        json: async () => ({
          default_generation_settings: { n_ctx: 4096 },
          memory: { active_bytes: 3000000 },
        }),
      });

      await engine.loadChat('/models/test-mlx');
      const status = engine.getChatStatus();
      // kvCacheBytes should be 0 when no model_info
      assert.ok(status.memoryEstimate);
      assert.strictEqual(status.memoryEstimate!.kvCacheBytes, 0);
      assert.strictEqual(status.memoryEstimate!.modelBytes, 3000000);
    });

    it('should set memoryEstimate to null when no bytes info', async () => {
      fetchFn = async () => ({
        ok: true,
        json: async () => ({
          default_generation_settings: {},
        }),
      });

      await engine.loadChat('/models/test-mlx');
      assert.strictEqual(engine.getChatStatus().memoryEstimate, null);
    });

    it('should pass reasoningBudget to server start', async () => {
      fetchFn = async () => ({ ok: false });
      await engine.loadChat('/models/test-mlx', { reasoningBudget: 512 });
      assert.strictEqual(mlxServerInstances[0].running, true);
    });

    it('should reset state before starting new model', async () => {
      // First load with props
      fetchFn = async () => ({
        ok: true,
        json: async () => ({
          memory: { active_bytes: 5000000 },
          model_info: { num_hidden_layers: 1, num_key_value_heads: 1, head_dim: 1 },
          default_generation_settings: { n_ctx: 2048 },
        }),
      });
      await engine.loadChat('/models/model-a');

      // Stop first server so it doesn't short-circuit
      mlxServerInstances[0].running = false;

      // Now load second model with failed props
      fetchFn = async () => ({ ok: false });
      await engine.loadChat('/models/model-b');

      // memoryEstimate should be reset to null
      assert.strictEqual(engine.getChatStatus().memoryEstimate, null);
    });
  });

  describe('unloadChat', () => {
    it('should stop the chat server', async () => {
      fetchFn = async () => ({ ok: false });
      await engine.loadChat('/models/test-mlx');
      await engine.unloadChat();
      assert.strictEqual(mlxServerInstances[0].running, false);
    });

    it('should do nothing when no server', async () => {
      await engine.unloadChat(); // should not throw
    });
  });

  describe('swapChat', () => {
    it('should unload and reload', async () => {
      fetchFn = async () => ({ ok: false });
      await engine.loadChat('/models/model-a');
      await engine.swapChat('/models/model-b');
      const server = mlxServerInstances[0];
      assert.strictEqual(server.modelPath, '/models/model-b');
      assert.strictEqual(server.running, true);
    });
  });

  describe('ensureRunningChat', () => {
    it('should start chat if not running', async () => {
      fetchFn = async () => ({ ok: false });
      await engine.ensureRunningChat('test-model');
      assert.strictEqual(mlxServerInstances.length, 1);
      assert.strictEqual(mlxServerInstances[0].running, true);
    });

    it('should do nothing if already running', async () => {
      fetchFn = async () => ({ ok: false });
      await engine.loadChat('/models/test-mlx');
      await engine.ensureRunningChat('test-model');
      assert.strictEqual(mlxServerInstances.length, 1);
    });
  });

  describe('getChatStatus', () => {
    it('should return not running when no server', () => {
      const status = engine.getChatStatus();
      assert.deepStrictEqual(status, {
        running: false,
        activeModel: null,
        port: null,
        contextSize: null,
        memoryEstimate: null,
        supportsVision: false,
        mmprojBytes: 0,
        processMemory: null,
      });
    });

    it('should return running status', async () => {
      fetchFn = async () => ({ ok: false });
      await engine.loadChat('/models/test-mlx');
      const status = engine.getChatStatus();
      assert.strictEqual(status.running, true);
      assert.strictEqual(status.activeModel, '/models/test-mlx');
      assert.strictEqual(status.port, 9090);
    });
  });

  describe('getChatBaseUrl', () => {
    it('should return null when no server', () => {
      assert.strictEqual(engine.getChatBaseUrl(), null);
    });

    it('should return null when not ready', async () => {
      fetchFn = async () => ({ ok: false });
      await engine.loadChat('/models/test-mlx');
      mlxServerInstances[0].ready = false;
      assert.strictEqual(engine.getChatBaseUrl(), null);
    });

    it('should return URL when ready', async () => {
      fetchFn = async () => ({ ok: false });
      await engine.loadChat('/models/test-mlx');
      assert.strictEqual(engine.getChatBaseUrl(), 'http://127.0.0.1:9090');
    });
  });

  // ─── Embedding ──────────────────────────────────────────────────────────────

  describe('loadEmbedding', () => {
    it('should start embedding server', async () => {
      await engine.loadEmbedding('/models/embed-mlx');
      const embServer = mlxServerInstances.find((s: any) => s._role === 'embedding');
      assert.ok(embServer);
      assert.strictEqual(embServer.running, true);
      assert.strictEqual(embServer.modelPath, '/models/embed-mlx');
    });

    it('should skip if same model already running', async () => {
      await engine.loadEmbedding('/models/embed-mlx');
      await engine.loadEmbedding('/models/embed-mlx');
      const embServers = mlxServerInstances.filter((s: any) => s._role === 'embedding');
      assert.strictEqual(embServers.length, 1);
    });
  });

  describe('unloadEmbedding', () => {
    it('should stop embedding server', async () => {
      await engine.loadEmbedding('/models/embed-mlx');
      await engine.unloadEmbedding();
      const embServer = mlxServerInstances.find((s: any) => s._role === 'embedding');
      assert.strictEqual(embServer.running, false);
    });

    it('should do nothing when no server', async () => {
      await engine.unloadEmbedding(); // should not throw
    });
  });

  describe('ensureRunningEmbedding', () => {
    it('should start embedding if not running', async () => {
      await engine.ensureRunningEmbedding('embed-model');
      const embServer = mlxServerInstances.find((s: any) => s._role === 'embedding');
      assert.ok(embServer);
      assert.strictEqual(embServer.running, true);
    });

    it('should do nothing if already running', async () => {
      await engine.loadEmbedding('/models/embed-mlx');
      await engine.ensureRunningEmbedding('embed-model');
      const embServers = mlxServerInstances.filter((s: any) => s._role === 'embedding');
      assert.strictEqual(embServers.length, 1);
    });
  });

  describe('getEmbeddingStatus', () => {
    it('should return not running when no server', () => {
      const status = engine.getEmbeddingStatus();
      assert.deepStrictEqual(status, {
        running: false,
        activeModel: null,
        port: null,
        contextSize: null,
        memoryEstimate: null,
      });
    });

    it('should return running status', async () => {
      await engine.loadEmbedding('/models/embed-mlx');
      const status = engine.getEmbeddingStatus();
      assert.strictEqual(status.running, true);
      assert.strictEqual(status.activeModel, '/models/embed-mlx');
    });
  });

  describe('getEmbeddingBaseUrl', () => {
    it('should return null when no server', () => {
      assert.strictEqual(engine.getEmbeddingBaseUrl(), null);
    });

    it('should return URL when ready', async () => {
      await engine.loadEmbedding('/models/embed-mlx');
      assert.strictEqual(engine.getEmbeddingBaseUrl(), 'http://127.0.0.1:9090');
    });
  });

  // ─── Combined ───────────────────────────────────────────────────────────────

  describe('getStatus', () => {
    it('should return combined status', () => {
      setPlatform('darwin', 'arm64');
      const e = new MlxServeEngine();
      e.setBaseDir('/test/base');
      const status = e.getStatus();
      assert.strictEqual(status.engineName, 'mlx-serve');
      assert.strictEqual(status.available, true);
      assert.ok(status.chat);
      assert.ok(status.embedding);
    });
  });

  describe('killOrphans', () => {
    it('should call killOrphanedMlxServers with baseDir', () => {
      let calledDir: string | undefined;
      killOrphanedMlxServersFn = (dir) => { calledDir = dir; };
      engine.killOrphans();
      assert.strictEqual(calledDir, '/test/base');
    });
  });

  // ─── Binary management ─────────────────────────────────────────────────────

  describe('getBinaryVersion', () => {
    it('should return version', () => {
      getMlxBinaryVersionFn = () => '3.0.0';
      assert.strictEqual(engine.getBinaryVersion(), '3.0.0');
    });

    it('should return null when no binary', () => {
      getMlxBinaryVersionFn = () => null;
      assert.strictEqual(engine.getBinaryVersion(), null);
    });
  });

  describe('getBinarySource', () => {
    it('should return "managed" when not system binary', () => {
      getMlxBinaryVersionFn = () => '1.0.0';
      isMlxSystemBinaryFn = () => false;
      assert.strictEqual(engine.getBinarySource(), 'managed');
    });

    it('should return "system" when system binary', () => {
      getMlxBinaryVersionFn = () => '1.0.0';
      isMlxSystemBinaryFn = () => true;
      assert.strictEqual(engine.getBinarySource(), 'system');
    });

    it('should return null when no binary', () => {
      getMlxBinaryVersionFn = () => null;
      assert.strictEqual(engine.getBinarySource(), null);
    });
  });

  // ─── resolveModelPath ──────────────────────────────────────────────────────

  describe('resolveModelPath (via ensureRunningChat)', () => {
    it('should throw when model not found', async () => {
      findModelFileFn = async () => null;

      await assert.rejects(
        () => engine.ensureRunningChat('nonexistent'),
        { message: /not found/ },
      );
    });
  });
});
