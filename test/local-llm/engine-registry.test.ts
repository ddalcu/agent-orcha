import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import type { LocalEngine, EngineStatus, EngineChatStatus, EngineServerStatus, LoadOptions } from '../../lib/local-llm/engine-interface.ts';

// Mock the real engine imports and model manager so EngineRegistry doesn't pull in real engines
mock.module('../../lib/local-llm/engines/llama-cpp-engine.ts', {
  namedExports: {
    LlamaCppEngine: class FakeLlamaCpp implements LocalEngine {
      engineName = 'llama-cpp';
      _baseDir = '';
      _chatLoaded = false;
      _embLoaded = false;
      _orphansKilled = false;

      isAvailable() { return true; }
      setBaseDir(dir: string) { this._baseDir = dir; }
      async loadChat() { this._chatLoaded = true; }
      async unloadChat() { this._chatLoaded = false; }
      async swapChat() {}
      async ensureRunningChat() {}
      getChatStatus(): EngineChatStatus { return { running: this._chatLoaded, activeModel: null, port: null, contextSize: null, memoryEstimate: null, supportsVision: false }; }
      getChatBaseUrl() { return this._chatLoaded ? 'http://127.0.0.1:8080' : null; }
      async loadEmbedding() { this._embLoaded = true; }
      async unloadEmbedding() { this._embLoaded = false; }
      async ensureRunningEmbedding() {}
      getEmbeddingStatus(): EngineServerStatus { return { running: this._embLoaded, activeModel: null, port: null, contextSize: null, memoryEstimate: null }; }
      getEmbeddingBaseUrl() { return this._embLoaded ? 'http://127.0.0.1:8081' : null; }
      getStatus(): EngineStatus { return { engineName: 'llama-cpp', available: true, chat: this.getChatStatus(), embedding: this.getEmbeddingStatus() }; }
      killOrphans() { this._orphansKilled = true; }
      getBinaryVersion() { return '1.0.0'; }
      getBinarySource() { return 'managed' as const; }
      async checkForUpdate() { return { available: false }; }
      async updateBinary() {}
    },
  },
});

mock.module('../../lib/local-llm/engines/mlx-serve-engine.ts', {
  namedExports: {
    MlxServeEngine: class FakeMlxServe implements LocalEngine {
      engineName = 'mlx-serve';
      _baseDir = '';
      _chatLoaded = false;
      _embLoaded = false;
      _orphansKilled = false;

      isAvailable() { return false; }
      setBaseDir(dir: string) { this._baseDir = dir; }
      async loadChat() { this._chatLoaded = true; }
      async unloadChat() { this._chatLoaded = false; }
      async swapChat() {}
      async ensureRunningChat() {}
      getChatStatus(): EngineChatStatus { return { running: false, activeModel: null, port: null, contextSize: null, memoryEstimate: null, supportsVision: false }; }
      getChatBaseUrl() { return null; }
      async loadEmbedding() { this._embLoaded = true; }
      async unloadEmbedding() { this._embLoaded = false; }
      async ensureRunningEmbedding() {}
      getEmbeddingStatus(): EngineServerStatus { return { running: false, activeModel: null, port: null, contextSize: null, memoryEstimate: null }; }
      getEmbeddingBaseUrl() { return null; }
      getStatus(): EngineStatus { return { engineName: 'mlx-serve', available: false, chat: this.getChatStatus(), embedding: this.getEmbeddingStatus() }; }
      killOrphans() { this._orphansKilled = true; }
      getBinaryVersion() { return null; }
      getBinarySource() { return null; }
      async checkForUpdate() { return { available: false }; }
      async updateBinary() {}
    },
  },
});

mock.module('../../lib/local-llm/model-manager.ts', {
  namedExports: {
    ModelManager: class FakeModelManager {
      async findModelFile(name: string) {
        if (name === 'existing-model') return { filePath: '/models/existing.gguf', type: 'gguf' as const };
        return null;
      }
    },
  },
});

mock.module('../../lib/logger.ts', {
  namedExports: {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  },
});

const { EngineRegistry } = await import('../../lib/local-llm/engine-registry.ts');

describe('EngineRegistry', () => {
  let registry: InstanceType<typeof EngineRegistry>;

  beforeEach(() => {
    registry = new EngineRegistry();
  });

  describe('constructor', () => {
    it('should register llama-cpp and mlx-serve engines by default', () => {
      const all = registry.getAllEngines();
      assert.strictEqual(all.length, 2);
      const names = all.map(e => e.engineName);
      assert.ok(names.includes('llama-cpp'));
      assert.ok(names.includes('mlx-serve'));
    });
  });

  describe('register', () => {
    it('should add a custom engine', () => {
      const customEngine: LocalEngine = {
        engineName: 'custom-engine',
        isAvailable: () => true,
        setBaseDir: () => {},
        loadChat: async () => {},
        unloadChat: async () => {},
        swapChat: async () => {},
        ensureRunningChat: async () => {},
        getChatStatus: () => ({ running: false, activeModel: null, port: null, contextSize: null, memoryEstimate: null, supportsVision: false }),
        getChatBaseUrl: () => null,
        loadEmbedding: async () => {},
        unloadEmbedding: async () => {},
        ensureRunningEmbedding: async () => {},
        getEmbeddingStatus: () => ({ running: false, activeModel: null, port: null, contextSize: null, memoryEstimate: null }),
        getEmbeddingBaseUrl: () => null,
        getStatus: () => ({ engineName: 'custom-engine', available: true, chat: { running: false, activeModel: null, port: null, contextSize: null, memoryEstimate: null, supportsVision: false }, embedding: { running: false, activeModel: null, port: null, contextSize: null, memoryEstimate: null } }),
        killOrphans: () => {},
        getBinaryVersion: () => '1.0.0',
        getBinarySource: () => 'managed',
        checkForUpdate: async () => ({}),
        updateBinary: async () => {},
      };

      registry.register(customEngine);
      assert.strictEqual(registry.getAllEngines().length, 3);
      assert.strictEqual(registry.getEngine('custom-engine'), customEngine);
    });
  });

  describe('getEngine', () => {
    it('should return the engine by name', () => {
      const engine = registry.getEngine('llama-cpp');
      assert.ok(engine);
      assert.strictEqual(engine.engineName, 'llama-cpp');
    });

    it('should return undefined for unknown engine', () => {
      const engine = registry.getEngine('nonexistent');
      assert.strictEqual(engine, undefined);
    });
  });

  describe('getAvailableEngines', () => {
    it('should return only engines where isAvailable() is true', () => {
      const available = registry.getAvailableEngines();
      // llama-cpp is available, mlx-serve is not in our mocks
      assert.strictEqual(available.length, 1);
      assert.strictEqual(available[0]!.engineName, 'llama-cpp');
    });
  });

  describe('getAllEngines', () => {
    it('should return all registered engines', () => {
      const all = registry.getAllEngines();
      assert.strictEqual(all.length, 2);
    });
  });

  describe('getAllStatus', () => {
    it('should return status for all engines keyed by name', () => {
      const status = registry.getAllStatus();
      assert.ok('llama-cpp' in status);
      assert.ok('mlx-serve' in status);
      assert.strictEqual(status['llama-cpp']!.engineName, 'llama-cpp');
      assert.strictEqual(status['mlx-serve']!.engineName, 'mlx-serve');
    });
  });

  describe('setBaseDir', () => {
    it('should set baseDir on all engines', () => {
      registry.setBaseDir('/test/dir');
      const engines = registry.getAllEngines();
      for (const engine of engines) {
        assert.strictEqual((engine as any)._baseDir, '/test/dir');
      }
    });
  });

  describe('killAllOrphans', () => {
    it('should call killOrphans on all engines', () => {
      registry.killAllOrphans();
      const engines = registry.getAllEngines();
      for (const engine of engines) {
        assert.strictEqual((engine as any)._orphansKilled, true);
      }
    });
  });

  describe('unloadAll', () => {
    it('should call unloadChat and unloadEmbedding on all engines', async () => {
      // First load something
      const llamaCpp = registry.getEngine('llama-cpp')!;
      await llamaCpp.loadChat('/test.gguf');
      await llamaCpp.loadEmbedding('/embed.gguf');

      assert.strictEqual((llamaCpp as any)._chatLoaded, true);
      assert.strictEqual((llamaCpp as any)._embLoaded, true);

      await registry.unloadAll();

      assert.strictEqual((llamaCpp as any)._chatLoaded, false);
      assert.strictEqual((llamaCpp as any)._embLoaded, false);
    });
  });

  describe('resolveModelPath', () => {
    it('should resolve an existing model', async () => {
      registry.setBaseDir('/base');
      const result = await registry.resolveModelPath('existing-model');
      assert.strictEqual(result.filePath, '/models/existing.gguf');
      assert.strictEqual(result.type, 'gguf');
    });

    it('should throw for non-existent model', async () => {
      registry.setBaseDir('/base');
      await assert.rejects(
        () => registry.resolveModelPath('nonexistent'),
        { message: /not found/ },
      );
    });
  });
});
