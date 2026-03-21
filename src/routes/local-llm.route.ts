import * as os from 'os';
import type { FastifyPluginAsync } from 'fastify';
import { ModelManager } from '../../lib/local-llm/index.ts';
import { engineRegistry } from '../../lib/local-llm/engine-registry.ts';
import {
  getLLMConfig,
  saveLLMConfig,
  LLMFactory,
  resolveDefaultName,
} from '../../lib/llm/index.ts';
import { detectProvider } from '../../lib/llm/provider-detector.ts';
import { detectGpu, queryNvidiaVram } from '../../lib/local-llm/binary-manager.ts';
import { logger } from '../../lib/logger.ts';

const DEFAULT_ENGINE_URLS: Record<string, string> = {
  ollama: 'http://localhost:11434',
  lmstudio: 'http://localhost:1234',
};

function getEngineUrl(engine: string): string {
  const config = getLLMConfig();
  return config?.engineUrls?.[engine] || DEFAULT_ENGINE_URLS[engine] || '';
}

async function fetchOllamaCapabilities(baseUrl: string, modelName: string): Promise<string[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 250);
    const res = await fetch(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return [];
    const data = await res.json() as any;
    return Array.isArray(data.capabilities) ? data.capabilities : [];
  } catch {
    return [];
  }
}

async function fetchOllamaRunning(baseUrl: string): Promise<any[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 250);
    const res = await fetch(`${baseUrl}/api/ps`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return [];
    const data = await res.json() as any;
    return data.models || [];
  } catch {
    return [];
  }
}

async function unloadOllamaModel(baseUrl: string, model: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

async function unloadLmStudioModel(baseUrl: string, instanceId: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${baseUrl}/api/v1/models/unload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instance_id: instanceId }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

async function probeExternalEngine(engine: 'ollama' | 'lmstudio'): Promise<{ available: boolean; models: any[]; running: any[] }> {
  const baseUrl = getEngineUrl(engine);
  const timeout = 250;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    let models: any[] = [];
    let running: any[] = [];
    if (engine === 'ollama') {
      const res = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return { available: false, models: [], running: [] };
      const data = await res.json() as any;
      const rawModels = data.models || [];

      // Fetch capabilities + running models in parallel
      const [capsResults, runningModels] = await Promise.all([
        Promise.all(rawModels.map((m: any) => fetchOllamaCapabilities(baseUrl, m.name))),
        fetchOllamaRunning(baseUrl),
      ]);

      // Build running model map: name -> { sizeVram, contextLength }
      const runMap = new Map<string, any>();
      for (const r of runningModels) {
        runMap.set(r.name, r);
      }

      models = rawModels.map((m: any, i: number) => {
        const rm = runMap.get(m.name);
        return {
          name: m.name,
          size: m.size,
          parameterSize: m.details?.parameter_size || null,
          family: m.details?.family || null,
          quantization: m.details?.quantization_level || null,
          capabilities: capsResults[i],
          loaded: !!rm,
          sizeVram: rm?.size_vram || null,
          contextLength: rm?.context_length || null,
        };
      });

      running = runningModels.map((r: any) => ({
        name: r.name,
        size: r.size,
        sizeVram: r.size_vram,
        contextLength: r.context_length,
        expiresAt: r.expires_at,
      }));
    } else {
      // Use LM Studio's rich API for capabilities, loaded state, and instance IDs
      const res = await fetch(`${baseUrl}/api/v1/models`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return { available: false, models: [], running: [] };
      const data = await res.json() as any;
      const rawModels = data.models || [];

      models = rawModels.map((m: any) => {
        const caps: string[] = [];
        if (m.capabilities?.vision) caps.push('vision');
        if (m.capabilities?.trained_for_tool_use) caps.push('tools');
        const instances = m.loaded_instances || [];
        return {
          name: m.key,
          type: m.type || null,
          arch: m.architecture || null,
          quantization: m.quantization?.name || null,
          size: m.size_bytes || null,
          parameterSize: m.params_string || null,
          maxContextLength: m.max_context_length || null,
          format: m.format || null,
          capabilities: caps,
          loaded: instances.length > 0,
          instanceId: instances[0]?.id || null,
          contextLength: instances[0]?.config?.context_length || null,
        };
      });

      running = models
        .filter((m: any) => m.loaded)
        .map((m: any) => ({
          name: m.name,
          size: m.size,
          instanceId: m.instanceId,
          contextLength: m.contextLength,
        }));
    }
    return { available: true, models, running };
  } catch {
    return { available: false, models: [], running: [] };
  }
}

export const localLlmRoutes: FastifyPluginAsync = async (fastify) => {
  const workspaceRoot = fastify.orchestrator.workspaceRoot;
  const manager = new ModelManager(workspaceRoot);
  const llmJsonPath = fastify.orchestrator.llmConfigPath;

  // GET /engines — probe availability of all local engines
  fastify.get('/engines', async () => {
    const llamaEngine = engineRegistry.getEngine('llama-cpp')!;
    const mlxEngine = engineRegistry.getEngine('mlx-serve')!;

    const [ollama, lmstudio] = await Promise.all([
      probeExternalEngine('ollama'),
      probeExternalEngine('lmstudio'),
    ]);

    return {
      'llama-cpp': { available: llamaEngine.isAvailable() },
      'mlx-serve': { available: mlxEngine.isAvailable() },
      ollama: { available: ollama.available, models: ollama.models, running: ollama.running },
      lmstudio: { available: lmstudio.available, models: lmstudio.models, running: lmstudio.running },
    };
  });

  // GET /engines/urls — return custom engine base URLs
  fastify.get('/engines/urls', async () => {
    const config = getLLMConfig();
    return {
      ollama: config?.engineUrls?.ollama || DEFAULT_ENGINE_URLS.ollama,
      lmstudio: config?.engineUrls?.lmstudio || DEFAULT_ENGINE_URLS.lmstudio,
    };
  });

  // POST /engines/urls — set a custom base URL for an external engine
  fastify.post<{ Body: { engine: string; url: string } }>(
    '/engines/urls',
    async (request, reply) => {
      const { engine, url } = request.body as any;
      if (!engine || !url) {
        return reply.status(400).send({ error: 'engine and url are required' });
      }
      if (engine !== 'ollama' && engine !== 'lmstudio') {
        return reply.status(400).send({ error: 'engine must be ollama or lmstudio' });
      }

      // Strip trailing slash
      const cleanUrl = url.replace(/\/+$/, '');

      const config = getLLMConfig();
      if (!config) {
        return reply.status(500).send({ error: 'LLM config not loaded' });
      }

      if (!config.engineUrls) config.engineUrls = {};
      // If it matches the default, remove the override
      if (cleanUrl === DEFAULT_ENGINE_URLS[engine]) {
        delete config.engineUrls[engine];
        if (Object.keys(config.engineUrls).length === 0) delete config.engineUrls;
      } else {
        config.engineUrls[engine] = cleanUrl;
      }

      await saveLLMConfig(llmJsonPath, config);
      return { ok: true };
    },
  );

  // POST /engines/activate — activate an external engine model (ollama/lmstudio)
  fastify.post<{ Body: { engine: string; model: string; role?: string } }>(
    '/engines/activate',
    async (request, reply) => {
      const { engine, model, role = 'chat' } = request.body as any;
      if (!engine || !model) {
        return reply.status(400).send({ error: 'engine and model are required' });
      }
      if (engine !== 'ollama' && engine !== 'lmstudio') {
        return reply.status(400).send({ error: 'engine must be ollama or lmstudio' });
      }

      const baseUrl = `${getEngineUrl(engine)}/v1`;

      const config = getLLMConfig();
      if (!config) {
        return reply.status(500).send({ error: 'LLM config not loaded' });
      }

      if (role === 'embedding') {
        // Stop any managed embedding engines
        for (const e of engineRegistry.getAllEngines()) {
          if (e.getEmbeddingStatus().running) await e.unloadEmbedding();
        }
        config.embeddings[engine] = {
          provider: 'local' as const,
          engine: engine as 'ollama' | 'lmstudio',
          baseUrl,
          model,
        };
        config.embeddings['default'] = engine;
      } else {
        // Stop any managed chat engines
        for (const e of engineRegistry.getAllEngines()) {
          if (e.getChatStatus().running) await e.unloadChat();
        }
        // Preserve reasoningBudget and active from the current entry
        const resolvedKey = resolveDefaultName('models');
        const currentDefault = typeof config.models[resolvedKey] === 'object' ? config.models[resolvedKey] as Record<string, any> : null;
        const existingExt = typeof config.models[engine] === 'object' ? config.models[engine] as Record<string, any> : null;
        config.models[engine] = {
          provider: 'local' as const,
          engine: engine as 'ollama' | 'lmstudio',
          baseUrl,
          model,
          ...(currentDefault?.reasoningBudget != null ? { reasoningBudget: currentDefault.reasoningBudget } : {}),
          ...(existingExt?.active != null ? { active: existingExt.active } : {}),
          ...(existingExt?.p2p != null ? { p2p: existingExt.p2p } : {}),
        };
        config.models['default'] = engine;
      }

      await saveLLMConfig(llmJsonPath, config);
      LLMFactory.clearCache();

      // For LM Studio, unload running models first, then load the new one
      if (engine === 'lmstudio') {
        const lmBaseUrl = getEngineUrl('lmstudio');
        // Unload all currently loaded models to free memory
        try {
          const probe = await probeExternalEngine('lmstudio');
          for (const r of probe.running) {
            if (r.instanceId) {
              await unloadLmStudioModel(lmBaseUrl, r.instanceId);
            }
          }
        } catch (err) {
          logger.warn('[LocalLLM] Failed to unload existing LM Studio models:', err);
        }
        // Load the new model
        try {
          const modelConfig = config.models[engine];
          const ctxSize = (modelConfig && typeof modelConfig === 'object') ? (modelConfig as any).contextSize : undefined;
          const loadRes = await fetch(`${lmBaseUrl}/api/v1/models/load`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model,
              ...(ctxSize ? { context_length: ctxSize } : {}),
            }),
          });
          if (!loadRes.ok) {
            logger.warn(`[LocalLLM] LM Studio model load returned ${loadRes.status}`);
          }
        } catch (err) {
          logger.warn('[LocalLLM] Failed to load model in LM Studio:', err);
        }
      }

      return { ok: true };
    },
  );

  // POST /engines/context — update context size for external engines
  fastify.post<{ Body: { contextSize: number } }>(
    '/engines/context',
    async (request, reply) => {
      const { contextSize } = request.body as any;
      if (!contextSize || typeof contextSize !== 'number') {
        return reply.status(400).send({ error: 'contextSize is required' });
      }

      const config = getLLMConfig();
      if (!config) {
        return reply.status(500).send({ error: 'LLM config not loaded' });
      }

      // Resolve the default pointer to the actual config entry
      const resolvedKey = resolveDefaultName('models');
      const defaultModel = config.models[resolvedKey];
      if (!defaultModel || typeof defaultModel === 'string') {
        return reply.status(400).send({ error: 'No default model configured' });
      }

      // Save to llm.json
      defaultModel.contextSize = contextSize;
      await saveLLMConfig(llmJsonPath, config);
      LLMFactory.clearCache();

      // For LM Studio, reload the model with new context_length
      if (defaultModel.engine === 'lmstudio') {
        try {
          const loadRes = await fetch(`${getEngineUrl('lmstudio')}/api/v1/models/load`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: defaultModel.model,
              context_length: contextSize,
            }),
          });
          if (!loadRes.ok) {
            logger.warn(`[LocalLLM] LM Studio model reload returned ${loadRes.status}`);
          }
        } catch (err) {
          logger.warn('[LocalLLM] Failed to reload LM Studio model with new context:', err);
        }
      }

      return { ok: true };
    },
  );

  // POST /engines/unload — unload a model from Ollama or LM Studio
  fastify.post<{ Body: { engine: string; model: string; instanceId?: string } }>(
    '/engines/unload',
    async (request, reply) => {
      const { engine, model, instanceId } = request.body as any;
      if (!engine || !model) {
        return reply.status(400).send({ error: 'engine and model are required' });
      }

      let ok = false;
      if (engine === 'ollama') {
        ok = await unloadOllamaModel(getEngineUrl('ollama'), model);
      } else if (engine === 'lmstudio') {
        // LM Studio needs instance_id; if not provided, probe for it
        let iid = instanceId;
        if (!iid) {
          try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 2000);
            const r = await fetch(`${getEngineUrl('lmstudio')}/api/v1/models`, { signal: ctrl.signal });
            clearTimeout(t);
            if (r.ok) {
              const d = await r.json() as any;
              const found = (d.models || []).find((m: any) => m.key === model && m.loaded_instances?.length);
              iid = found?.loaded_instances?.[0]?.id;
            }
          } catch { /* ignore */ }
        }
        if (!iid) {
          return reply.status(400).send({ error: `No loaded instance found for ${model}` });
        }
        ok = await unloadLmStudioModel(getEngineUrl('lmstudio'), iid);
      } else {
        return reply.status(400).send({ error: 'engine must be ollama or lmstudio' });
      }

      if (!ok) {
        return reply.status(500).send({ error: `Failed to unload ${model} from ${engine}` });
      }
      return { ok: true };
    },
  );

  // GET /status — return per-engine status
  fastify.get('/status', async () => {
    const gpu = detectGpu();
    const state = await manager.getState();
    const config = getLLMConfig();
    const resolvedKey = resolveDefaultName('models');
    const defaultModel = config?.models[resolvedKey];
    const defaultProvider = (defaultModel && typeof defaultModel !== 'string') ? detectProvider(defaultModel) : null;
    const defaultEngine = (defaultModel && typeof defaultModel !== 'string') ? (defaultModel.engine || null) : null;

    const llamaEngine = engineRegistry.getEngine('llama-cpp')!;
    const mlxEngine = engineRegistry.getEngine('mlx-serve')!;

    return {
      engines: engineRegistry.getAllStatus(),
      available: true,
      lastActiveModel: state.lastActiveModel,
      systemRamBytes: os.totalmem(),
      freeRamBytes: os.freemem(),
      gpu,
      gpuVram: gpu.accel?.startsWith('cuda') || gpu.accel === 'vulkan' ? queryNvidiaVram() : null,
      defaultProvider,
      defaultEngine,
      platform: process.platform,
      arch: process.arch,
      // Per-engine binary info for frontend compatibility
      llamaVersion: llamaEngine.getBinaryVersion(),
      binarySource: llamaEngine.getBinarySource() ?? 'managed',
      mlxVersion: mlxEngine.getBinaryVersion(),
      mlxBinarySource: mlxEngine.getBinarySource() ?? 'managed',
    };
  });

  // GET /models
  fastify.get('/models', async () => {
    return manager.listModels();
  });

  // GET /models/downloads — active download progress (pollable)
  fastify.get('/models/downloads', async () => {
    return manager.getActiveDownloads();
  });

  // GET /models/interrupted — partial downloads from previous sessions
  fastify.get('/models/interrupted', async () => {
    return manager.getInterruptedDownloads();
  });

  // DELETE /models/interrupted/:fileName — discard a partial download
  fastify.delete<{ Params: { fileName: string } }>(
    '/models/interrupted/:fileName',
    async (request) => {
      await manager.deleteInterruptedDownload(request.params.fileName);
      return { ok: true };
    },
  );

  // GET /models/download?repo=...&fileName=...&type=gguf|mlx  (SSE stream)
  fastify.get<{ Querystring: { repo: string; fileName: string; type?: string } }>(
    '/models/download',
    async (request, reply) => {
      const { repo, fileName, type } = request.query;
      if (!repo) {
        return reply.status(400).send({ error: 'repo is required' });
      }
      if (type !== 'mlx' && !fileName) {
        return reply.status(400).send({ error: 'fileName is required for GGUF downloads' });
      }

      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');

      let clientDisconnected = false;
      reply.raw.on('close', () => { clientDisconnected = true; });

      try {
        let model;

        if (type === 'mlx') {
          // MLX: download entire repo
          model = await manager.downloadMlxModel(
            repo,
            (progress) => {
              if (!clientDisconnected) {
                reply.raw.write(`data: ${JSON.stringify({ type: 'progress', ...progress })}\n\n`);
              }
            },
          );
        } else {
          // GGUF: download single file
          model = await manager.downloadModel(
            repo,
            fileName,
            (progress) => {
              if (!clientDisconnected) {
                reply.raw.write(`data: ${JSON.stringify({ type: 'progress', ...progress })}\n\n`);
              }
            },
          );

          // Auto-download mmproj for vision models (skip if user downloaded an mmproj directly)
          if (!clientDisconnected && !fileName.toLowerCase().includes('mmproj')) {
            const mmproj = await manager.autoDownloadMmproj(
              repo,
              (progress) => {
                if (!clientDisconnected) {
                  reply.raw.write(`data: ${JSON.stringify({ type: 'progress', ...progress })}\n\n`);
                }
              },
            );
            if (mmproj && !clientDisconnected) {
              reply.raw.write(`data: ${JSON.stringify({ type: 'mmproj', model: mmproj })}\n\n`);
            }
          }
        }

        if (!clientDisconnected) {
          reply.raw.write(`data: ${JSON.stringify({ type: 'complete', model })}\n\n`);
        }
      } catch (err: any) {
        if (!clientDisconnected) {
          const message = err instanceof Error ? err.message : String(err);
          reply.raw.write(`data: ${JSON.stringify({ type: 'error', error: message })}\n\n`);
        }
      }

      reply.raw.end();
    },
  );

  // POST /models/:id/activate — route to correct engine, NO cross-engine kill
  fastify.post<{ Params: { id: string } }>(
    '/models/:id/activate',
    async (request, reply) => {
      const model = await manager.getModel(request.params.id);
      if (!model) {
        return reply.status(404).send({ error: 'Model not found' });
      }

      // Read existing config for contextSize and reasoningBudget from the resolved default
      const fullConfig = getLLMConfig();
      const resolvedKey = resolveDefaultName('models');
      const currentDefault = fullConfig?.models[resolvedKey];
      const currentObj = (currentDefault && typeof currentDefault !== 'string') ? currentDefault : null;

      const engineName = model.type === 'mlx' ? 'mlx-serve' : 'llama-cpp';
      const engine = engineRegistry.getEngine(engineName);
      if (!engine) {
        return reply.status(500).send({ error: `Engine ${engineName} not available` });
      }

      try {
        await engine.swapChat(model.filePath, {
          ...(currentObj?.contextSize !== undefined ? { contextSize: currentObj.contextSize } : {}),
          ...(currentObj?.reasoningBudget !== undefined ? { reasoningBudget: currentObj.reasoningBudget } : {}),
        });
      } catch (err: any) {
        logger.error('[LocalLLM] Failed to load model:', err);
        return reply.status(500).send({ error: `Failed to load: ${err.message}` });
      }

      const chatStatus = engine.getChatStatus();
      const detectedCtx = chatStatus.contextSize;
      const modelName = model.type === 'mlx' ? model.fileName : model.fileName.replace(/\.gguf$/i, '');
      const existingEntry = fullConfig?.models[engineName];
      const existingObj = (existingEntry && typeof existingEntry !== 'string') ? existingEntry : null;
      const localEntry = {
        provider: 'local' as const,
        engine: engineName as 'llama-cpp' | 'mlx-serve',
        model: modelName,
        ...(detectedCtx ? { contextSize: detectedCtx } : {}),
        reasoningBudget: currentObj?.reasoningBudget ?? 0,
        ...(existingObj?.active != null ? { active: existingObj.active } : {}),
        ...(existingObj?.p2p != null ? { p2p: existingObj.p2p } : {}),
      };

      // Update llm.json — write to engine key and set default pointer
      try {
        const config = getLLMConfig();
        if (config) {
          config.models[engineName] = localEntry;
          config.models['default'] = engineName;
          await saveLLMConfig(llmJsonPath, config);
          LLMFactory.clearCache();
        }
      } catch (err: any) {
        logger.error('[LocalLLM] Failed to update llm.json:', err);
      }

      // Save state
      await manager.saveState({ lastActiveModel: model.id });

      return { ok: true, status: engine.getStatus() };
    },
  );

  // POST /models/:id/activate-embedding
  fastify.post<{ Params: { id: string } }>(
    '/models/:id/activate-embedding',
    async (request, reply) => {
      const model = await manager.getModel(request.params.id);
      if (!model) {
        return reply.status(404).send({ error: 'Model not found' });
      }

      const engineName = model.type === 'mlx' ? 'mlx-serve' : 'llama-cpp';
      const engine = engineRegistry.getEngine(engineName);
      if (!engine) {
        return reply.status(500).send({ error: `Engine ${engineName} not available` });
      }

      try {
        await engine.loadEmbedding(model.filePath);
      } catch (err: any) {
        logger.error('[LocalLLM] Failed to load embedding model:', err);
        return reply.status(500).send({ error: `Failed to load: ${err.message}` });
      }

      // Update llm.json — write to engine key and set default pointer
      try {
        const config = getLLMConfig();
        if (config) {
          const embModelName = model.type === 'mlx' ? model.fileName : model.fileName.replace(/\.gguf$/i, '');
          config.embeddings[engineName] = {
            provider: 'local' as const,
            engine: engineName as 'llama-cpp' | 'mlx-serve',
            model: embModelName,
          };
          config.embeddings['default'] = engineName;
          await saveLLMConfig(llmJsonPath, config);
        }
      } catch (err: any) {
        logger.error('[LocalLLM] Failed to update llm.json:', err);
      }

      return { ok: true, status: engine.getEmbeddingStatus() };
    },
  );

  // DELETE /models/:id
  fastify.delete<{ Params: { id: string } }>(
    '/models/:id',
    async (request, reply) => {
      const model = await manager.getModel(request.params.id);
      if (!model) {
        return reply.status(404).send({ error: 'Model not found' });
      }

      // Don't delete if currently active in any engine (chat or embedding)
      for (const engine of engineRegistry.getAllEngines()) {
        const chatStatus = engine.getChatStatus();
        if (chatStatus.running && chatStatus.activeModel === model.filePath) {
          return reply.status(409).send({ error: 'Cannot delete the currently active model. Stop it first.' });
        }
        const embStatus = engine.getEmbeddingStatus();
        if (embStatus.running && embStatus.activeModel === model.filePath) {
          return reply.status(409).send({ error: 'Cannot delete the active embedding model. Stop it first.' });
        }
      }

      await manager.deleteModel(request.params.id);
      return { ok: true };
    },
  );

  // GET /browse?q=...&limit=10&format=gguf|mlx
  fastify.get<{ Querystring: { q: string; limit?: string; format?: string } }>(
    '/browse',
    async (request, reply) => {
      const { q, limit, format } = request.query;
      if (!q) {
        return reply.status(400).send({ error: 'q (query) is required' });
      }
      const fmt = format === 'mlx' ? 'mlx' : 'gguf';
      return manager.browseHuggingFace(q, Number(limit) || 10, fmt);
    },
  );

  // POST /stop — accept optional engine param to stop specific engine
  fastify.post<{ Body: { engine?: string } }>('/stop', async (request) => {
    const engineName = (request.body as any)?.engine;
    if (engineName) {
      const engine = engineRegistry.getEngine(engineName);
      if (engine) await engine.unloadChat();
    } else {
      // Legacy: stop all managed chat engines
      for (const engine of engineRegistry.getAllEngines()) {
        await engine.unloadChat();
      }
    }
    return { ok: true };
  });

  // POST /stop-embedding — accept optional engine param
  fastify.post<{ Body: { engine?: string } }>('/stop-embedding', async (request) => {
    const engineName = (request.body as any)?.engine;
    if (engineName) {
      const engine = engineRegistry.getEngine(engineName);
      if (engine) await engine.unloadEmbedding();
    } else {
      for (const engine of engineRegistry.getAllEngines()) {
        await engine.unloadEmbedding();
      }
    }
    return { ok: true };
  });

};
