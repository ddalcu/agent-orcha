import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import { createTestApp } from '../helpers/mock-fastify.ts';

// ---- Mock engine builder ----
function createMockEngine(overrides: Record<string, any> = {}) {
  return {
    engineName: overrides.engineName ?? 'llama-cpp',
    isAvailable: () => overrides.available ?? true,
    loadChat: mock.fn(async () => {}),
    unloadChat: mock.fn(async () => {}),
    swapChat: mock.fn(async () => {}),
    ensureRunningChat: mock.fn(async () => {}),
    getChatStatus: () => overrides.chatStatus ?? {
      running: false, activeModel: null, port: null,
      contextSize: null, memoryEstimate: null, supportsVision: false,
    },
    getChatBaseUrl: () => null,
    loadEmbedding: mock.fn(async () => {}),
    unloadEmbedding: mock.fn(async () => {}),
    ensureRunningEmbedding: mock.fn(async () => {}),
    getEmbeddingStatus: () => overrides.embeddingStatus ?? {
      running: false, activeModel: null, port: null,
      contextSize: null, memoryEstimate: null,
    },
    getEmbeddingBaseUrl: () => null,
    getStatus: () => overrides.status ?? {
      engineName: overrides.engineName ?? 'llama-cpp',
      available: overrides.available ?? true,
      chat: { running: false, activeModel: null, port: null, contextSize: null, memoryEstimate: null, supportsVision: false },
      embedding: { running: false, activeModel: null, port: null, contextSize: null, memoryEstimate: null },
    },
    killOrphans: mock.fn(() => {}),
    getBinaryVersion: () => overrides.binaryVersion ?? '1.0.0',
    getBinarySource: () => overrides.binarySource ?? 'managed',
    setBaseDir: mock.fn(() => {}),
  };
}

// ---- Mock ModelManager ----
function createMockModelManager() {
  return {
    listModels: mock.fn(async () => []),
    getModel: mock.fn(async (_id: string) => null),
    deleteModel: mock.fn(async () => {}),
    browseHuggingFace: mock.fn(async () => []),
    downloadModel: mock.fn(async () => ({ id: 'model-1', fileName: 'test.gguf' })),
    downloadMlxModel: mock.fn(async () => ({ id: 'model-1', fileName: 'test-mlx' })),
    autoDownloadMmproj: mock.fn(async () => null),
    getActiveDownloads: mock.fn(() => []),
    getInterruptedDownloads: mock.fn(async () => []),
    deleteInterruptedDownload: mock.fn(async () => {}),
    getState: mock.fn(async () => ({ lastActiveModel: null })),
    saveState: mock.fn(async () => {}),
    findModelFile: mock.fn(async () => null),
  };
}

// Mutable state that the module-level mocks delegate to
let mockLlamaEngine: ReturnType<typeof createMockEngine>;
let mockMlxEngine: ReturnType<typeof createMockEngine>;
let mockManager: ReturnType<typeof createMockModelManager>;
let llmConfigFn: () => any;
let saveLLMConfigFn: (...args: any[]) => Promise<void>;
let resolveDefaultNameFn: (...args: any[]) => string;
let detectProviderFn: (...args: any[]) => string;
let fetchFn: (...args: any[]) => Promise<any>;
let app: any;

function defaultLLMConfig() {
  return {
    models: {
      default: 'llama-cpp',
      'llama-cpp': { provider: 'local', engine: 'llama-cpp', model: 'test-model' },
    },
    embeddings: {
      default: 'llama-cpp',
      'llama-cpp': { provider: 'local', engine: 'llama-cpp', model: 'embed-model' },
    },
    engineUrls: {},
  };
}

// ---- Module mocks (must be registered before importing the route) ----

mock.module('../../lib/local-llm/engine-registry.ts', {
  namedExports: {
    engineRegistry: {
      getEngine: (name: string) => {
        if (name === 'llama-cpp') return mockLlamaEngine;
        if (name === 'mlx-serve') return mockMlxEngine;
        return undefined;
      },
      getAllEngines: () => [mockLlamaEngine, mockMlxEngine],
      getAllStatus: () => ({
        'llama-cpp': mockLlamaEngine?.getStatus(),
        'mlx-serve': mockMlxEngine?.getStatus(),
      }),
    },
  },
});

mock.module('../../lib/llm/llm-config.ts', {
  namedExports: {
    getLLMConfig: (..._args: any[]) => llmConfigFn(),
    saveLLMConfig: (...args: any[]) => saveLLMConfigFn(...args),
    resolveDefaultName: (...args: any[]) => resolveDefaultNameFn(...args),
    loadLLMConfig: () => {},
    getModelConfig: () => null,
    getEmbeddingConfig: () => null,
    listModelConfigs: () => [],
    listEmbeddingConfigs: () => [],
    isLLMConfigLoaded: () => true,
    getLLMConfigPath: () => null,
    resolveApiKey: () => null,
  },
});

mock.module('../../lib/llm/index.ts', {
  namedExports: {
    getLLMConfig: (..._args: any[]) => llmConfigFn(),
    saveLLMConfig: (...args: any[]) => saveLLMConfigFn(...args),
    resolveDefaultName: (...args: any[]) => resolveDefaultNameFn(...args),
    LLMFactory: { clearCache: () => {} },
    loadLLMConfig: () => {},
    getModelConfig: () => null,
    getEmbeddingConfig: () => null,
    listModelConfigs: () => [],
    listEmbeddingConfigs: () => [],
    isLLMConfigLoaded: () => true,
    getLLMConfigPath: () => null,
    resolveApiKey: () => null,
  },
});

mock.module('../../lib/llm/llm-factory.ts', {
  namedExports: {
    LLMFactory: { clearCache: () => {} },
  },
});

mock.module('../../lib/llm/provider-detector.ts', {
  namedExports: {
    detectProvider: (...args: any[]) => detectProviderFn(...args),
  },
});

mock.module('../../lib/local-llm/binary-manager.ts', {
  namedExports: {
    detectGpu: () => ({ accel: 'metal' }),
    queryNvidiaVram: () => null,
    getBinaryPath: () => null,
  },
});

mock.module('../../lib/local-llm/model-manager.ts', {
  namedExports: {
    ModelManager: function (this: any) {
      Object.assign(this, mockManager);
    },
  },
});

// Now import the route (after all mock.module calls)
const { localLlmRoutes } = await import('../../src/routes/local-llm.route.ts');

describe('local-llm.route', () => {
  beforeEach(() => {
    mockLlamaEngine = createMockEngine({ engineName: 'llama-cpp' });
    mockMlxEngine = createMockEngine({ engineName: 'mlx-serve' });
    mockManager = createMockModelManager();
    llmConfigFn = () => defaultLLMConfig();
    saveLLMConfigFn = async () => {};
    resolveDefaultNameFn = () => 'llama-cpp';
    detectProviderFn = () => 'local';
    fetchFn = async () => { throw new Error('mocked fetch: connection refused'); };
  });

  afterEach(async () => {
    if (app) { await app.close(); app = null; }
  });

  async function buildApp(overrides: Record<string, any> = {}) {
    mock.method(globalThis, 'fetch', (...args: any[]) => fetchFn(...args));
    const result = await createTestApp(localLlmRoutes, '/api/local-llm', {
      llmConfigPath: '/tmp/test-project/llm.json',
      ...overrides,
    });
    app = result.app;
    return result;
  }

  // ==================== GET /engines ====================
  describe('GET /engines', () => {
    it('should return engine availability', async () => {
      await buildApp();
      const res = await app.inject({ method: 'GET', url: '/api/local-llm/engines' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body['llama-cpp'].available, true);
      assert.equal(body['mlx-serve'].available, true);
      assert.equal(body.ollama.available, false);
      assert.equal(body.lmstudio.available, false);
    });
  });

  // ==================== GET /engines/urls ====================
  describe('GET /engines/urls', () => {
    it('should return default URLs when no overrides', async () => {
      await buildApp();
      const res = await app.inject({ method: 'GET', url: '/api/local-llm/engines/urls' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.ollama, 'http://localhost:11434');
      assert.equal(body.lmstudio, 'http://localhost:1234');
    });

    it('should return custom URLs when configured', async () => {
      llmConfigFn = () => ({
        ...defaultLLMConfig(),
        engineUrls: { ollama: 'http://custom:11434' },
      });
      await buildApp();
      const res = await app.inject({ method: 'GET', url: '/api/local-llm/engines/urls' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.ollama, 'http://custom:11434');
      assert.equal(body.lmstudio, 'http://localhost:1234');
    });
  });

  // ==================== POST /engines/urls ====================
  describe('POST /engines/urls', () => {
    it('should return 400 when engine or url is missing', async () => {
      await buildApp();
      const res = await app.inject({
        method: 'POST', url: '/api/local-llm/engines/urls',
        payload: { engine: 'ollama' },
      });
      assert.equal(res.statusCode, 400);
    });

    it('should return 400 for invalid engine', async () => {
      await buildApp();
      const res = await app.inject({
        method: 'POST', url: '/api/local-llm/engines/urls',
        payload: { engine: 'invalid', url: 'http://foo' },
      });
      assert.equal(res.statusCode, 400);
    });

    it('should return 500 when config is null', async () => {
      llmConfigFn = () => null;
      await buildApp();
      const res = await app.inject({
        method: 'POST', url: '/api/local-llm/engines/urls',
        payload: { engine: 'ollama', url: 'http://custom:11434' },
      });
      assert.equal(res.statusCode, 500);
    });

    it('should save custom URL', async () => {
      let savedConfig: any = null;
      saveLLMConfigFn = async (_path: string, config: any) => { savedConfig = config; };
      await buildApp();
      const res = await app.inject({
        method: 'POST', url: '/api/local-llm/engines/urls',
        payload: { engine: 'ollama', url: 'http://custom:11434/' },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(res.payload).ok, true);
      assert.ok(savedConfig);
      assert.equal(savedConfig.engineUrls.ollama, 'http://custom:11434');
    });

    it('should remove override when URL matches default', async () => {
      llmConfigFn = () => ({
        ...defaultLLMConfig(),
        engineUrls: { ollama: 'http://old:1111' },
      });
      let savedConfig: any = null;
      saveLLMConfigFn = async (_path: string, config: any) => { savedConfig = config; };
      await buildApp();
      const res = await app.inject({
        method: 'POST', url: '/api/local-llm/engines/urls',
        payload: { engine: 'ollama', url: 'http://localhost:11434' },
      });
      assert.equal(res.statusCode, 200);
      assert.ok(savedConfig);
      assert.equal(savedConfig.engineUrls, undefined);
    });
  });

  // ==================== POST /engines/activate ====================
  describe('POST /engines/activate', () => {
    it('should return 400 when engine or model is missing', async () => {
      await buildApp();
      const res = await app.inject({
        method: 'POST', url: '/api/local-llm/engines/activate',
        payload: { engine: 'ollama' },
      });
      assert.equal(res.statusCode, 400);
    });

    it('should return 400 for invalid engine', async () => {
      await buildApp();
      const res = await app.inject({
        method: 'POST', url: '/api/local-llm/engines/activate',
        payload: { engine: 'invalid', model: 'test' },
      });
      assert.equal(res.statusCode, 400);
    });

    it('should return 500 when config is null', async () => {
      llmConfigFn = () => null;
      await buildApp();
      const res = await app.inject({
        method: 'POST', url: '/api/local-llm/engines/activate',
        payload: { engine: 'ollama', model: 'llama3' },
      });
      assert.equal(res.statusCode, 500);
    });

    it('should activate ollama model for chat role', async () => {
      let savedConfig: any = null;
      saveLLMConfigFn = async (_p: string, c: any) => { savedConfig = c; };
      await buildApp();
      const res = await app.inject({
        method: 'POST', url: '/api/local-llm/engines/activate',
        payload: { engine: 'ollama', model: 'llama3' },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(res.payload).ok, true);
      assert.ok(savedConfig);
      assert.equal(savedConfig.models.default, 'ollama');
      assert.equal(savedConfig.models.ollama.model, 'llama3');
    });

    it('should activate model for embedding role', async () => {
      let savedConfig: any = null;
      saveLLMConfigFn = async (_p: string, c: any) => { savedConfig = c; };
      await buildApp();
      const res = await app.inject({
        method: 'POST', url: '/api/local-llm/engines/activate',
        payload: { engine: 'ollama', model: 'nomic-embed', role: 'embedding' },
      });
      assert.equal(res.statusCode, 200);
      assert.ok(savedConfig);
      assert.equal(savedConfig.embeddings.default, 'ollama');
      assert.equal(savedConfig.embeddings.ollama.model, 'nomic-embed');
    });

    it('should activate lmstudio model and attempt load', async () => {
      let loadCalled = false;
      fetchFn = async (url: any) => {
        const u = String(url);
        if (u.includes('/api/v1/models') && !u.includes('/load') && !u.includes('/unload')) {
          return { ok: true, json: async () => ({ models: [] }) };
        }
        if (u.includes('/api/v1/models/load')) {
          loadCalled = true;
          return { ok: true, json: async () => ({}) };
        }
        throw new Error('connection refused');
      };

      await buildApp();
      const res = await app.inject({
        method: 'POST', url: '/api/local-llm/engines/activate',
        payload: { engine: 'lmstudio', model: 'my-model' },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(res.payload).ok, true);
      assert.equal(loadCalled, true);
    });

    it('should stop managed engines before activating external', async () => {
      mockLlamaEngine.getEmbeddingStatus = () => ({
        running: true, activeModel: '/embed', port: 8081, contextSize: null, memoryEstimate: null,
      });
      await buildApp();
      const res = await app.inject({
        method: 'POST', url: '/api/local-llm/engines/activate',
        payload: { engine: 'ollama', model: 'nomic', role: 'embedding' },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(mockLlamaEngine.unloadEmbedding.mock.callCount(), 1);
    });
  });

  // ==================== POST /engines/context ====================
  describe('POST /engines/context', () => {
    it('should return 400 when contextSize is missing', async () => {
      await buildApp();
      const res = await app.inject({
        method: 'POST', url: '/api/local-llm/engines/context',
        payload: {},
      });
      assert.equal(res.statusCode, 400);
    });

    it('should return 400 when contextSize is not a number', async () => {
      await buildApp();
      const res = await app.inject({
        method: 'POST', url: '/api/local-llm/engines/context',
        payload: { contextSize: 'abc' },
      });
      assert.equal(res.statusCode, 400);
    });

    it('should return 500 when config is null', async () => {
      llmConfigFn = () => null;
      await buildApp();
      const res = await app.inject({
        method: 'POST', url: '/api/local-llm/engines/context',
        payload: { contextSize: 4096 },
      });
      assert.equal(res.statusCode, 500);
    });

    it('should return 400 when no default model configured', async () => {
      llmConfigFn = () => ({
        models: { default: 'nonexistent' },
        embeddings: {},
      });
      resolveDefaultNameFn = () => 'nonexistent';
      await buildApp();
      const res = await app.inject({
        method: 'POST', url: '/api/local-llm/engines/context',
        payload: { contextSize: 4096 },
      });
      assert.equal(res.statusCode, 400);
    });

    it('should return 400 when default model is a string alias', async () => {
      llmConfigFn = () => ({
        models: { default: 'other', other: 'still-a-string' },
        embeddings: {},
      });
      resolveDefaultNameFn = () => 'other';
      await buildApp();
      const res = await app.inject({
        method: 'POST', url: '/api/local-llm/engines/context',
        payload: { contextSize: 4096 },
      });
      assert.equal(res.statusCode, 400);
    });

    it('should update context size successfully', async () => {
      let savedConfig: any = null;
      saveLLMConfigFn = async (_p: string, c: any) => { savedConfig = c; };
      await buildApp();
      const res = await app.inject({
        method: 'POST', url: '/api/local-llm/engines/context',
        payload: { contextSize: 8192 },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(res.payload).ok, true);
      assert.ok(savedConfig);
    });

    it('should reload LM Studio model when engine is lmstudio', async () => {
      llmConfigFn = () => ({
        models: {
          default: 'lmstudio',
          lmstudio: { provider: 'local', engine: 'lmstudio', model: 'my-model' },
        },
        embeddings: {},
      });
      resolveDefaultNameFn = () => 'lmstudio';

      let loadCalled = false;
      fetchFn = async (url: any) => {
        if (String(url).includes('/api/v1/models/load')) {
          loadCalled = true;
          return { ok: true, json: async () => ({}) };
        }
        throw new Error('connection refused');
      };

      await buildApp();
      const res = await app.inject({
        method: 'POST', url: '/api/local-llm/engines/context',
        payload: { contextSize: 4096 },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(loadCalled, true);
    });
  });

  // ==================== POST /engines/unload ====================
  describe('POST /engines/unload', () => {
    it('should return 400 when engine or model is missing', async () => {
      await buildApp();
      const res = await app.inject({
        method: 'POST', url: '/api/local-llm/engines/unload',
        payload: { engine: 'ollama' },
      });
      assert.equal(res.statusCode, 400);
    });

    it('should return 400 for unsupported engine', async () => {
      await buildApp();
      const res = await app.inject({
        method: 'POST', url: '/api/local-llm/engines/unload',
        payload: { engine: 'invalid', model: 'test' },
      });
      assert.equal(res.statusCode, 400);
    });

    it('should unload ollama model successfully', async () => {
      fetchFn = async () => ({ ok: true, json: async () => ({}) });
      await buildApp();
      const res = await app.inject({
        method: 'POST', url: '/api/local-llm/engines/unload',
        payload: { engine: 'ollama', model: 'llama3' },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(res.payload).ok, true);
    });

    it('should return 500 when ollama unload fails', async () => {
      await buildApp();
      const res = await app.inject({
        method: 'POST', url: '/api/local-llm/engines/unload',
        payload: { engine: 'ollama', model: 'llama3' },
      });
      assert.equal(res.statusCode, 500);
    });

    it('should unload lmstudio model with provided instanceId', async () => {
      fetchFn = async () => ({ ok: true, json: async () => ({}) });
      await buildApp();
      const res = await app.inject({
        method: 'POST', url: '/api/local-llm/engines/unload',
        payload: { engine: 'lmstudio', model: 'my-model', instanceId: 'inst-1' },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(res.payload).ok, true);
    });

    it('should return 400 when lmstudio instance not found', async () => {
      await buildApp();
      const res = await app.inject({
        method: 'POST', url: '/api/local-llm/engines/unload',
        payload: { engine: 'lmstudio', model: 'my-model' },
      });
      assert.equal(res.statusCode, 400);
    });

    it('should probe lmstudio for instanceId when not provided', async () => {
      fetchFn = async (url: any) => {
        const u = String(url);
        if (u.includes('/api/v1/models') && !u.includes('/unload')) {
          return {
            ok: true,
            json: async () => ({
              models: [{ key: 'my-model', loaded_instances: [{ id: 'probed-inst' }] }],
            }),
          };
        }
        if (u.includes('/api/v1/models/unload')) {
          return { ok: true, json: async () => ({}) };
        }
        throw new Error('unexpected');
      };

      await buildApp();
      const res = await app.inject({
        method: 'POST', url: '/api/local-llm/engines/unload',
        payload: { engine: 'lmstudio', model: 'my-model' },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(res.payload).ok, true);
    });
  });

  // ==================== GET /status ====================
  describe('GET /status', () => {
    it('should return status info', async () => {
      await buildApp();
      const res = await app.inject({ method: 'GET', url: '/api/local-llm/status' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok(body.engines);
      assert.equal(body.available, true);
      assert.ok(body.gpu);
      assert.equal(body.gpu.accel, 'metal');
      assert.equal(body.defaultProvider, 'local');
      assert.equal(body.platform, process.platform);
      assert.equal(body.arch, process.arch);
      assert.ok('llamaVersion' in body);
      assert.ok('mlxVersion' in body);
      assert.ok('systemRamBytes' in body);
      assert.ok('freeRamBytes' in body);
    });

    it('should handle null default model', async () => {
      llmConfigFn = () => ({ models: {}, embeddings: {} });
      resolveDefaultNameFn = () => 'default';
      await buildApp();
      const res = await app.inject({ method: 'GET', url: '/api/local-llm/status' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.defaultProvider, null);
      assert.equal(body.defaultEngine, null);
    });
  });

  // ==================== GET /models ====================
  describe('GET /models', () => {
    it('should list models', async () => {
      await buildApp();
      const res = await app.inject({ method: 'GET', url: '/api/local-llm/models' });
      assert.equal(res.statusCode, 200);
      assert.ok(Array.isArray(JSON.parse(res.payload)));
    });
  });

  // ==================== GET /models/downloads ====================
  describe('GET /models/downloads', () => {
    it('should return active downloads', async () => {
      await buildApp();
      const res = await app.inject({ method: 'GET', url: '/api/local-llm/models/downloads' });
      assert.equal(res.statusCode, 200);
      assert.ok(Array.isArray(JSON.parse(res.payload)));
    });
  });

  // ==================== GET /models/interrupted ====================
  describe('GET /models/interrupted', () => {
    it('should return interrupted downloads', async () => {
      await buildApp();
      const res = await app.inject({ method: 'GET', url: '/api/local-llm/models/interrupted' });
      assert.equal(res.statusCode, 200);
      assert.ok(Array.isArray(JSON.parse(res.payload)));
    });
  });

  // ==================== DELETE /models/interrupted/:fileName ====================
  describe('DELETE /models/interrupted/:fileName', () => {
    it('should delete interrupted download', async () => {
      await buildApp();
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/local-llm/models/interrupted/test.gguf.part',
      });
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(res.payload).ok, true);
    });
  });

  // ==================== GET /models/download (SSE) ====================
  describe('GET /models/download', () => {
    it('should return 400 when repo is missing', async () => {
      await buildApp();
      const res = await app.inject({ method: 'GET', url: '/api/local-llm/models/download' });
      assert.equal(res.statusCode, 400);
    });

    it('should return 400 when fileName is missing for GGUF', async () => {
      await buildApp();
      const res = await app.inject({
        method: 'GET', url: '/api/local-llm/models/download?repo=user/model',
      });
      assert.equal(res.statusCode, 400);
    });

    it('should stream GGUF download progress', async () => {
      mockManager.downloadModel = mock.fn(async (_repo: string, _file: string, cb: any) => {
        cb({ percent: 50, downloadedBytes: 500, totalBytes: 1000 });
        return { id: 'model-1', fileName: 'test.gguf' };
      });
      mockManager.autoDownloadMmproj = mock.fn(async () => null);

      await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/local-llm/models/download?repo=user/model&fileName=test.gguf',
      });
      assert.equal(res.statusCode, 200);
      assert.ok(res.payload.includes('"type":"progress"'));
      assert.ok(res.payload.includes('"type":"complete"'));
    });

    it('should stream MLX download without requiring fileName', async () => {
      mockManager.downloadMlxModel = mock.fn(async (_repo: string, cb: any) => {
        cb({ percent: 100 });
        return { id: 'mlx-1', fileName: 'test-mlx' };
      });

      await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/local-llm/models/download?repo=user/model&type=mlx',
      });
      assert.equal(res.statusCode, 200);
      assert.ok(res.payload.includes('"type":"complete"'));
    });

    it('should stream error on download failure', async () => {
      mockManager.downloadModel = mock.fn(async () => { throw new Error('Download failed'); });

      await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/local-llm/models/download?repo=user/model&fileName=test.gguf',
      });
      assert.equal(res.statusCode, 200);
      assert.ok(res.payload.includes('"type":"error"'));
      assert.ok(res.payload.includes('Download failed'));
    });

    it('should include mmproj event when auto-download finds one', async () => {
      mockManager.downloadModel = mock.fn(async () => ({ id: 'model-1', fileName: 'test.gguf' }));
      mockManager.autoDownloadMmproj = mock.fn(async () => ({ id: 'mmproj-1', fileName: 'mmproj.gguf' }));

      await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/local-llm/models/download?repo=user/model&fileName=test.gguf',
      });
      assert.equal(res.statusCode, 200);
      assert.ok(res.payload.includes('"type":"mmproj"'));
      assert.ok(res.payload.includes('"type":"complete"'));
    });

    it('should skip mmproj for mmproj files', async () => {
      mockManager.downloadModel = mock.fn(async () => ({ id: 'model-1', fileName: 'mmproj-test.gguf' }));

      await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/local-llm/models/download?repo=user/model&fileName=mmproj-test.gguf',
      });
      assert.equal(res.statusCode, 200);
      assert.ok(res.payload.includes('"type":"complete"'));
      assert.equal(mockManager.autoDownloadMmproj.mock.callCount(), 0);
    });
  });

  // ==================== POST /models/:id/activate ====================
  describe('POST /models/:id/activate', () => {
    it('should return 404 when model not found', async () => {
      await buildApp();
      const res = await app.inject({
        method: 'POST', url: '/api/local-llm/models/nonexistent/activate',
      });
      assert.equal(res.statusCode, 404);
    });

    it('should activate GGUF model via llama-cpp engine', async () => {
      mockManager.getModel = mock.fn(async (id: string) =>
        id === 'model-1' ? { id: 'model-1', fileName: 'test.gguf', filePath: '/models/test.gguf', type: 'gguf' } : null
      );
      mockLlamaEngine.getChatStatus = () => ({
        running: true, activeModel: '/models/test.gguf', port: 8080,
        contextSize: 4096, memoryEstimate: null, supportsVision: false,
      });

      await buildApp();
      const res = await app.inject({
        method: 'POST', url: '/api/local-llm/models/model-1/activate',
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.ok, true);
      assert.ok(body.status);
      assert.equal(mockLlamaEngine.swapChat.mock.callCount(), 1);
    });

    it('should activate MLX model via mlx-serve engine', async () => {
      mockManager.getModel = mock.fn(async (id: string) =>
        id === 'mlx-1' ? { id: 'mlx-1', fileName: 'test-mlx', filePath: '/models/test-mlx', type: 'mlx' } : null
      );

      await buildApp();
      const res = await app.inject({
        method: 'POST', url: '/api/local-llm/models/mlx-1/activate',
      });
      assert.equal(res.statusCode, 200);
      assert.equal(mockMlxEngine.swapChat.mock.callCount(), 1);
    });

    it('should return 500 when swapChat fails', async () => {
      mockManager.getModel = mock.fn(async () =>
        ({ id: 'model-1', fileName: 'test.gguf', filePath: '/models/test.gguf', type: 'gguf' })
      );
      mockLlamaEngine.swapChat = mock.fn(async () => { throw new Error('swap failed'); });

      await buildApp();
      const res = await app.inject({
        method: 'POST', url: '/api/local-llm/models/model-1/activate',
      });
      assert.equal(res.statusCode, 500);
      assert.ok(JSON.parse(res.payload).error.includes('swap failed'));
    });

    it('should save state and update llm.json on success', async () => {
      mockManager.getModel = mock.fn(async () =>
        ({ id: 'model-1', fileName: 'test.gguf', filePath: '/models/test.gguf', type: 'gguf' })
      );
      let savedConfig: any = null;
      saveLLMConfigFn = async (_p: string, c: any) => { savedConfig = c; };

      await buildApp();
      await app.inject({
        method: 'POST', url: '/api/local-llm/models/model-1/activate',
      });
      assert.ok(savedConfig);
      assert.equal(savedConfig.models.default, 'llama-cpp');
      assert.equal(mockManager.saveState.mock.callCount(), 1);
    });
  });

  // ==================== POST /models/:id/activate-embedding ====================
  describe('POST /models/:id/activate-embedding', () => {
    it('should return 404 when model not found', async () => {
      await buildApp();
      const res = await app.inject({
        method: 'POST', url: '/api/local-llm/models/nonexistent/activate-embedding',
      });
      assert.equal(res.statusCode, 404);
    });

    it('should activate embedding model', async () => {
      mockManager.getModel = mock.fn(async () =>
        ({ id: 'emb-1', fileName: 'embed.gguf', filePath: '/models/embed.gguf', type: 'gguf' })
      );

      await buildApp();
      const res = await app.inject({
        method: 'POST', url: '/api/local-llm/models/emb-1/activate-embedding',
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.ok, true);
      assert.ok(body.status);
      assert.equal(mockLlamaEngine.loadEmbedding.mock.callCount(), 1);
    });

    it('should return 500 when loadEmbedding fails', async () => {
      mockManager.getModel = mock.fn(async () =>
        ({ id: 'emb-1', fileName: 'embed.gguf', filePath: '/models/embed.gguf', type: 'gguf' })
      );
      mockLlamaEngine.loadEmbedding = mock.fn(async () => { throw new Error('load failed'); });

      await buildApp();
      const res = await app.inject({
        method: 'POST', url: '/api/local-llm/models/emb-1/activate-embedding',
      });
      assert.equal(res.statusCode, 500);
      assert.ok(JSON.parse(res.payload).error.includes('load failed'));
    });

    it('should activate MLX embedding model', async () => {
      mockManager.getModel = mock.fn(async () =>
        ({ id: 'mlx-emb', fileName: 'mlx-embed', filePath: '/models/mlx-embed', type: 'mlx' })
      );

      await buildApp();
      const res = await app.inject({
        method: 'POST', url: '/api/local-llm/models/mlx-emb/activate-embedding',
      });
      assert.equal(res.statusCode, 200);
      assert.equal(mockMlxEngine.loadEmbedding.mock.callCount(), 1);
    });

    it('should update llm.json with embedding config', async () => {
      mockManager.getModel = mock.fn(async () =>
        ({ id: 'emb-1', fileName: 'embed.gguf', filePath: '/models/embed.gguf', type: 'gguf' })
      );
      let savedConfig: any = null;
      saveLLMConfigFn = async (_p: string, c: any) => { savedConfig = c; };

      await buildApp();
      await app.inject({
        method: 'POST', url: '/api/local-llm/models/emb-1/activate-embedding',
      });
      assert.ok(savedConfig);
      assert.equal(savedConfig.embeddings.default, 'llama-cpp');
      assert.equal(savedConfig.embeddings['llama-cpp'].model, 'embed');
    });
  });

  // ==================== DELETE /models/:id ====================
  describe('DELETE /models/:id', () => {
    it('should return 404 when model not found', async () => {
      await buildApp();
      const res = await app.inject({ method: 'DELETE', url: '/api/local-llm/models/nonexistent' });
      assert.equal(res.statusCode, 404);
    });

    it('should delete model successfully', async () => {
      mockManager.getModel = mock.fn(async (id: string) =>
        id === 'model-1' ? { id: 'model-1', fileName: 'test.gguf', filePath: '/models/test.gguf', type: 'gguf' } : null
      );

      await buildApp();
      const res = await app.inject({ method: 'DELETE', url: '/api/local-llm/models/model-1' });
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(res.payload).ok, true);
    });

    it('should return 409 when model is active in chat', async () => {
      mockManager.getModel = mock.fn(async () =>
        ({ id: 'model-1', fileName: 'test.gguf', filePath: '/models/test.gguf', type: 'gguf' })
      );
      mockLlamaEngine.getChatStatus = () => ({
        running: true, activeModel: '/models/test.gguf', port: 8080,
        contextSize: 4096, memoryEstimate: null, supportsVision: false,
      });

      await buildApp();
      const res = await app.inject({ method: 'DELETE', url: '/api/local-llm/models/model-1' });
      assert.equal(res.statusCode, 409);
    });

    it('should return 409 when model is active in embedding', async () => {
      mockManager.getModel = mock.fn(async () =>
        ({ id: 'emb-1', fileName: 'embed.gguf', filePath: '/models/embed.gguf', type: 'gguf' })
      );
      mockLlamaEngine.getEmbeddingStatus = () => ({
        running: true, activeModel: '/models/embed.gguf', port: 8081,
        contextSize: null, memoryEstimate: null,
      });

      await buildApp();
      const res = await app.inject({ method: 'DELETE', url: '/api/local-llm/models/emb-1' });
      assert.equal(res.statusCode, 409);
    });
  });

  // ==================== GET /browse ====================
  describe('GET /browse', () => {
    it('should return 400 when q is missing', async () => {
      await buildApp();
      const res = await app.inject({ method: 'GET', url: '/api/local-llm/browse' });
      assert.equal(res.statusCode, 400);
    });

    it('should return browse results', async () => {
      mockManager.browseHuggingFace = mock.fn(async () => [{ name: 'model' }]);
      await buildApp();
      const res = await app.inject({ method: 'GET', url: '/api/local-llm/browse?q=llama' });
      assert.equal(res.statusCode, 200);
      assert.ok(Array.isArray(JSON.parse(res.payload)));
    });

    it('should pass limit and format params', async () => {
      let capturedLimit: number | undefined;
      let capturedFormat: string | undefined;
      mockManager.browseHuggingFace = mock.fn(async (q: string, limit: number, format: string) => {
        capturedLimit = limit;
        capturedFormat = format;
        return [];
      });
      await buildApp();
      await app.inject({ method: 'GET', url: '/api/local-llm/browse?q=llama&limit=5&format=mlx' });
      assert.equal(capturedLimit, 5);
      assert.equal(capturedFormat, 'mlx');
    });

    it('should default format to gguf', async () => {
      let capturedFormat: string | undefined;
      mockManager.browseHuggingFace = mock.fn(async (_q: string, _limit: number, format: string) => {
        capturedFormat = format;
        return [];
      });
      await buildApp();
      await app.inject({ method: 'GET', url: '/api/local-llm/browse?q=llama' });
      assert.equal(capturedFormat, 'gguf');
    });
  });

  // ==================== POST /stop ====================
  describe('POST /stop', () => {
    it('should stop all managed chat engines when no engine specified', async () => {
      await buildApp();
      const res = await app.inject({ method: 'POST', url: '/api/local-llm/stop', payload: {} });
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(res.payload).ok, true);
      assert.equal(mockLlamaEngine.unloadChat.mock.callCount(), 1);
      assert.equal(mockMlxEngine.unloadChat.mock.callCount(), 1);
    });

    it('should stop specific engine when specified', async () => {
      await buildApp();
      const res = await app.inject({
        method: 'POST', url: '/api/local-llm/stop',
        payload: { engine: 'llama-cpp' },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(mockLlamaEngine.unloadChat.mock.callCount(), 1);
      assert.equal(mockMlxEngine.unloadChat.mock.callCount(), 0);
    });
  });

  // ==================== POST /stop-embedding ====================
  describe('POST /stop-embedding', () => {
    it('should stop all embedding engines when no engine specified', async () => {
      await buildApp();
      const res = await app.inject({
        method: 'POST', url: '/api/local-llm/stop-embedding', payload: {},
      });
      assert.equal(res.statusCode, 200);
      assert.equal(mockLlamaEngine.unloadEmbedding.mock.callCount(), 1);
      assert.equal(mockMlxEngine.unloadEmbedding.mock.callCount(), 1);
    });

    it('should stop specific engine when specified', async () => {
      await buildApp();
      const res = await app.inject({
        method: 'POST', url: '/api/local-llm/stop-embedding',
        payload: { engine: 'mlx-serve' },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(mockLlamaEngine.unloadEmbedding.mock.callCount(), 0);
      assert.equal(mockMlxEngine.unloadEmbedding.mock.callCount(), 1);
    });
  });

});
