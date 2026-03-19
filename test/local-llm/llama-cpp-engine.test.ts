import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';

// ── Mutable mock delegates ──

let getBinaryVersionFn: (dir: string) => string | null;
let isSystemBinaryFn: () => boolean;
let detectGpuFn: () => { accel: string };
let killOrphanedServersFn: (dir: string) => void;
let readGGUFModelInfoFn: (p: string) => Promise<any>;
let calculateOptimalContextSizeFn: (info: any) => number;
let kvCacheBytesPerTokenFn: (info: any) => number;
let findModelFileFn: (name: string) => Promise<any>;
let findMmprojForModelFn: (name: string) => Promise<string | null>;

// Track LlamaServerProcess instances
let llamaServerInstances: any[] = [];
let modelManagerInstances: any[] = [];

// ── Module mocks ──

mock.module('../../lib/local-llm/binary-manager.ts', {
  namedExports: {
    getBinaryVersion: (dir: string) => getBinaryVersionFn(dir),
    isSystemBinary: () => isSystemBinaryFn(),
    detectGpu: () => detectGpuFn(),
    getProcessMemory: () => null,
    getBinaryPath: () => '/fake/llama-server',
  },
});

mock.module('../../lib/local-llm/llama-server-process.ts', {
  namedExports: {
    LlamaServerProcess: class FakeLlamaServerProcess {
      running = false;
      ready = false;
      modelPath: string | null = null;
      port: number | null = null;
      _baseDir: string;
      _isEmbedding: boolean;

      constructor(baseDir: string, isEmbedding = false) {
        this._baseDir = baseDir;
        this._isEmbedding = isEmbedding;
        llamaServerInstances.push(this);
      }

      async start(opts: any) {
        this.running = true;
        this.ready = true;
        this.modelPath = opts.modelPath;
        this.port = 8080;
      }

      async stop() {
        this.running = false;
        this.ready = false;
      }

      getBaseUrl() {
        return `http://127.0.0.1:${this.port}`;
      }
    },
    killOrphanedServers: (dir: string) => killOrphanedServersFn(dir),
  },
});

mock.module('../../lib/local-llm/gguf-reader.ts', {
  namedExports: {
    readGGUFModelInfo: (p: string) => readGGUFModelInfoFn(p),
    calculateOptimalContextSize: (info: any) => calculateOptimalContextSizeFn(info),
    kvCacheBytesPerToken: (info: any) => kvCacheBytesPerTokenFn(info),
  },
});

mock.module('../../lib/local-llm/model-manager.ts', {
  namedExports: {
    ModelManager: class FakeModelManager {
      _baseDir: string;
      constructor(baseDir: string) {
        this._baseDir = baseDir;
        modelManagerInstances.push(this);
      }
      async findMmprojForModel(name: string) {
        return findMmprojForModelFn(name);
      }
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

const { LlamaCppEngine } = await import('../../lib/local-llm/engines/llama-cpp-engine.ts');

describe('LlamaCppEngine', () => {
  let engine: InstanceType<typeof LlamaCppEngine>;

  beforeEach(() => {
    llamaServerInstances = [];
    modelManagerInstances = [];
    getBinaryVersionFn = () => '1.0.0';
    isSystemBinaryFn = () => false;
    detectGpuFn = () => ({ accel: 'none' });
    killOrphanedServersFn = () => {};
    readGGUFModelInfoFn = async () => null;
    calculateOptimalContextSizeFn = () => 4096;
    kvCacheBytesPerTokenFn = () => 256;
    findModelFileFn = async (name: string) => ({ filePath: `/models/${name}.gguf`, type: 'gguf' as const });
    findMmprojForModelFn = async () => null;

    engine = new LlamaCppEngine();
    engine.setBaseDir('/test/base');
  });

  describe('engineName', () => {
    it('should be "llama-cpp"', () => {
      assert.strictEqual(engine.engineName, 'llama-cpp');
    });
  });

  describe('setBaseDir', () => {
    it('should set the base directory', () => {
      engine.setBaseDir('/new/dir');
      // Verify by checking isAvailable uses the dir
      let passedDir: string | undefined;
      getBinaryVersionFn = (dir) => { passedDir = dir; return '1.0.0'; };
      engine.isAvailable();
      assert.strictEqual(passedDir, '/new/dir');
    });
  });

  describe('isAvailable', () => {
    it('should return true when binary version exists', () => {
      getBinaryVersionFn = () => '1.0.0';
      assert.strictEqual(engine.isAvailable(), true);
    });

    it('should return false when binary version is null', () => {
      getBinaryVersionFn = () => null;
      assert.strictEqual(engine.isAvailable(), false);
    });
  });

  // ─── Chat ───────────────────────────────────────────────────────────────────

  describe('loadChat', () => {
    it('should start the chat server with model', async () => {
      await engine.loadChat('/models/test.gguf');
      assert.strictEqual(llamaServerInstances.length, 1);
      assert.strictEqual(llamaServerInstances[0].running, true);
      assert.strictEqual(llamaServerInstances[0].modelPath, '/models/test.gguf');
    });

    it('should skip if same model already running', async () => {
      await engine.loadChat('/models/test.gguf');
      const instance = llamaServerInstances[0];
      // Call again with same model
      await engine.loadChat('/models/test.gguf');
      // Should still be same instance count (no new server created)
      assert.strictEqual(llamaServerInstances.length, 1);
      assert.strictEqual(instance.running, true);
    });

    it('should use GGUF model info for context size when no opts', async () => {
      const fakeModelInfo = { fileSizeBytes: 1000000 };
      readGGUFModelInfoFn = async () => fakeModelInfo;
      calculateOptimalContextSizeFn = () => 8192;
      kvCacheBytesPerTokenFn = () => 512;

      await engine.loadChat('/models/test.gguf');

      const status = engine.getChatStatus();
      assert.strictEqual(status.contextSize, 8192);
      assert.deepStrictEqual(status.memoryEstimate, {
        modelBytes: 1000000,
        kvCacheBytes: 8192 * 512,
        totalBytes: 1000000 + 8192 * 512,
      });
    });

    it('should use provided contextSize from opts', async () => {
      const fakeModelInfo = { fileSizeBytes: 500000 };
      readGGUFModelInfoFn = async () => fakeModelInfo;
      kvCacheBytesPerTokenFn = () => 128;

      await engine.loadChat('/models/test.gguf', { contextSize: 2048 });

      const status = engine.getChatStatus();
      assert.strictEqual(status.contextSize, 2048);
    });

    it('should detect GPU and pass gpu options', async () => {
      detectGpuFn = () => ({ accel: 'metal' });
      readGGUFModelInfoFn = async () => null;

      await engine.loadChat('/models/test.gguf');
      // Verify the server was started (GPU params are passed to start())
      assert.strictEqual(llamaServerInstances[0].running, true);
    });

    it('should detect non-metal GPU', async () => {
      detectGpuFn = () => ({ accel: 'cuda' });
      readGGUFModelInfoFn = async () => null;

      await engine.loadChat('/models/test.gguf');
      assert.strictEqual(llamaServerInstances[0].running, true);
    });

    it('should pass reasoningBudget when provided', async () => {
      readGGUFModelInfoFn = async () => null;

      await engine.loadChat('/models/test.gguf', { reasoningBudget: 1024 });
      assert.strictEqual(llamaServerInstances[0].running, true);
    });

    it('should set supportsVision=false when no mmproj', async () => {
      readGGUFModelInfoFn = async () => null;
      await engine.loadChat('/models/test.gguf');
      assert.strictEqual(engine.getChatStatus().supportsVision, false);
    });

    it('should set supportsVision=true when mmproj found', async () => {
      readGGUFModelInfoFn = async () => null;
      findMmprojForModelFn = async () => '/models/mmproj-vision.gguf';
      await engine.loadChat('/models/vision-model.gguf');
      assert.strictEqual(engine.getChatStatus().supportsVision, true);
    });

    it('should set contextSize to null when no info and no opts', async () => {
      readGGUFModelInfoFn = async () => null;
      await engine.loadChat('/models/test.gguf');
      assert.strictEqual(engine.getChatStatus().contextSize, null);
    });
  });

  describe('unloadChat', () => {
    it('should stop the chat server', async () => {
      await engine.loadChat('/models/test.gguf');
      await engine.unloadChat();
      assert.strictEqual(llamaServerInstances[0].running, false);
    });

    it('should do nothing when no server exists', async () => {
      await engine.unloadChat(); // should not throw
    });
  });

  describe('swapChat', () => {
    it('should unload and reload with new model', async () => {
      readGGUFModelInfoFn = async () => null;
      await engine.loadChat('/models/model-a.gguf');
      await engine.swapChat('/models/model-b.gguf');

      // The first server was stopped, a new start was called
      const server = llamaServerInstances[0];
      assert.strictEqual(server.modelPath, '/models/model-b.gguf');
      assert.strictEqual(server.running, true);
    });
  });

  describe('ensureRunningChat', () => {
    it('should start chat if not running', async () => {
      readGGUFModelInfoFn = async () => null;
      await engine.ensureRunningChat('test-model');
      assert.strictEqual(llamaServerInstances.length, 1);
      assert.strictEqual(llamaServerInstances[0].running, true);
    });

    it('should do nothing if already running', async () => {
      readGGUFModelInfoFn = async () => null;
      await engine.loadChat('/models/test.gguf');
      await engine.ensureRunningChat('test-model');
      // Should still only be 1 instance
      assert.strictEqual(llamaServerInstances.length, 1);
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

    it('should return running status with model', async () => {
      readGGUFModelInfoFn = async () => null;
      await engine.loadChat('/models/test.gguf');
      const status = engine.getChatStatus();
      assert.strictEqual(status.running, true);
      assert.strictEqual(status.activeModel, '/models/test.gguf');
      assert.strictEqual(status.port, 8080);
    });
  });

  describe('getChatBaseUrl', () => {
    it('should return null when no server', () => {
      assert.strictEqual(engine.getChatBaseUrl(), null);
    });

    it('should return null when server not ready', async () => {
      readGGUFModelInfoFn = async () => null;
      await engine.loadChat('/models/test.gguf');
      llamaServerInstances[0].ready = false;
      assert.strictEqual(engine.getChatBaseUrl(), null);
    });

    it('should return URL when server ready', async () => {
      readGGUFModelInfoFn = async () => null;
      await engine.loadChat('/models/test.gguf');
      assert.strictEqual(engine.getChatBaseUrl(), 'http://127.0.0.1:8080');
    });
  });

  // ─── Embedding ──────────────────────────────────────────────────────────────

  describe('loadEmbedding', () => {
    it('should start the embedding server', async () => {
      await engine.loadEmbedding('/models/embed.gguf');
      // Embedding creates a second server instance
      const embServer = llamaServerInstances.find((s: any) => s._isEmbedding);
      assert.ok(embServer);
      assert.strictEqual(embServer.running, true);
      assert.strictEqual(embServer.modelPath, '/models/embed.gguf');
    });

    it('should skip if same model already running', async () => {
      await engine.loadEmbedding('/models/embed.gguf');
      await engine.loadEmbedding('/models/embed.gguf');
      // Only one embedding server
      const embServers = llamaServerInstances.filter((s: any) => s._isEmbedding);
      assert.strictEqual(embServers.length, 1);
    });
  });

  describe('unloadEmbedding', () => {
    it('should stop the embedding server', async () => {
      await engine.loadEmbedding('/models/embed.gguf');
      await engine.unloadEmbedding();
      const embServer = llamaServerInstances.find((s: any) => s._isEmbedding);
      assert.strictEqual(embServer.running, false);
    });

    it('should do nothing when no server exists', async () => {
      await engine.unloadEmbedding(); // should not throw
    });
  });

  describe('ensureRunningEmbedding', () => {
    it('should start embedding if not running', async () => {
      await engine.ensureRunningEmbedding('embed-model');
      const embServer = llamaServerInstances.find((s: any) => s._isEmbedding);
      assert.ok(embServer);
      assert.strictEqual(embServer.running, true);
    });

    it('should do nothing if already running', async () => {
      await engine.loadEmbedding('/models/embed.gguf');
      await engine.ensureRunningEmbedding('embed-model');
      const embServers = llamaServerInstances.filter((s: any) => s._isEmbedding);
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
      await engine.loadEmbedding('/models/embed.gguf');
      const status = engine.getEmbeddingStatus();
      assert.strictEqual(status.running, true);
      assert.strictEqual(status.activeModel, '/models/embed.gguf');
    });
  });

  describe('getEmbeddingBaseUrl', () => {
    it('should return null when no server', () => {
      assert.strictEqual(engine.getEmbeddingBaseUrl(), null);
    });

    it('should return URL when server ready', async () => {
      await engine.loadEmbedding('/models/embed.gguf');
      assert.strictEqual(engine.getEmbeddingBaseUrl(), 'http://127.0.0.1:8080');
    });
  });

  // ─── Combined ───────────────────────────────────────────────────────────────

  describe('getStatus', () => {
    it('should return combined status', () => {
      const status = engine.getStatus();
      assert.strictEqual(status.engineName, 'llama-cpp');
      assert.strictEqual(status.available, true);
      assert.ok(status.chat);
      assert.ok(status.embedding);
    });

    it('should reflect unavailable when no binary', () => {
      getBinaryVersionFn = () => null;
      const status = engine.getStatus();
      assert.strictEqual(status.available, false);
    });
  });

  describe('killOrphans', () => {
    it('should call killOrphanedServers with baseDir', () => {
      let calledDir: string | undefined;
      killOrphanedServersFn = (dir) => { calledDir = dir; };
      engine.killOrphans();
      assert.strictEqual(calledDir, '/test/base');
    });
  });

  // ─── Binary management ─────────────────────────────────────────────────────

  describe('getBinaryVersion', () => {
    it('should return version from binary-manager', () => {
      getBinaryVersionFn = () => '2.5.0';
      assert.strictEqual(engine.getBinaryVersion(), '2.5.0');
    });

    it('should return null when no binary', () => {
      getBinaryVersionFn = () => null;
      assert.strictEqual(engine.getBinaryVersion(), null);
    });
  });

  describe('getBinarySource', () => {
    it('should return "managed" when not system binary', () => {
      getBinaryVersionFn = () => '1.0.0';
      isSystemBinaryFn = () => false;
      assert.strictEqual(engine.getBinarySource(), 'managed');
    });

    it('should return "system" when system binary', () => {
      getBinaryVersionFn = () => '1.0.0';
      isSystemBinaryFn = () => true;
      assert.strictEqual(engine.getBinarySource(), 'system');
    });

    it('should return null when no binary', () => {
      getBinaryVersionFn = () => null;
      assert.strictEqual(engine.getBinarySource(), null);
    });
  });

  // ─── resolveModelPath (private, tested via ensureRunning) ──────────────────

  describe('resolveModelPath (via ensureRunningChat)', () => {
    it('should throw when model not found', async () => {
      findModelFileFn = async () => null;

      await assert.rejects(
        () => engine.ensureRunningChat('nonexistent-model'),
        { message: /not found/ },
      );
    });
  });
});
