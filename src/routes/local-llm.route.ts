import * as fs from 'node:fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { FastifyPluginAsync } from 'fastify';
import { ModelManager } from '../../lib/local-llm/index.ts';
import type { LocalModel } from '../../lib/local-llm/index.ts';
import { generateDirName } from '../../lib/local-llm/model-manager.ts';
import { resolveModelFile } from '../../lib/local-llm/resolve-model-path.ts';
import { OmniModelCache } from '../../lib/llm/providers/omni-model-cache.ts';
import {
  getModelsConfig,
  saveModelsConfig,
  LLMFactory,
  resolveDefaultName,
  listImageConfigs,
  listTtsConfigs,
} from '../../lib/llm/index.ts';
import { detectProvider } from '../../lib/llm/provider-detector.ts';
import { execFileSync } from '../../lib/utils/child-process.ts';
import { logger } from '../../lib/logger.ts';

function queryNvidiaVram(): { totalBytes: number; usedBytes: number; freeBytes: number } | null {
  try {
    const output = execFileSync('nvidia-smi', [
      '--query-gpu=memory.total,memory.used,memory.free',
      '--format=csv,noheader,nounits',
    ], { encoding: 'utf-8', timeout: 5_000 }).trim();

    const firstGpu = output.split('\n')[0];
    if (!firstGpu) return null;

    const parts = firstGpu.split(',').map(s => parseInt(s.trim(), 10));
    if (parts.length < 3 || parts.some(isNaN)) return null;

    return {
      totalBytes: parts[0]! * 1024 * 1024,
      usedBytes: parts[1]! * 1024 * 1024,
      freeBytes: parts[2]! * 1024 * 1024,
    };
  } catch {
    return null;
  }
}

const DEFAULT_ENGINE_URLS: Record<string, string> = {
  ollama: 'http://localhost:11434',
  lmstudio: 'http://localhost:1234',
};

function getEngineUrl(engine: string): string {
  const config = getModelsConfig();
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
  const modelsConfigPath = fastify.orchestrator.modelsConfigPath;

  // GET /engines — probe availability of all local engines
  fastify.get('/engines', async () => {
    const omniStatus = OmniModelCache.getStatus();

    const [ollama, lmstudio] = await Promise.all([
      probeExternalEngine('ollama'),
      probeExternalEngine('lmstudio'),
    ]);

    return {
      omni: { available: true, gpu: omniStatus.gpu, models: omniStatus },
      ollama: { available: ollama.available, models: ollama.models, running: ollama.running },
      lmstudio: { available: lmstudio.available, models: lmstudio.models, running: lmstudio.running },
    };
  });

  // GET /engines/urls — return custom engine base URLs
  fastify.get('/engines/urls', async () => {
    const config = getModelsConfig();
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

      const config = getModelsConfig();
      if (!config) {
        return reply.status(500).send({ error: 'Models config not loaded' });
      }

      if (!config.engineUrls) config.engineUrls = {};
      // If it matches the default, remove the override
      if (cleanUrl === DEFAULT_ENGINE_URLS[engine]) {
        delete config.engineUrls[engine];
        if (Object.keys(config.engineUrls).length === 0) delete config.engineUrls;
      } else {
        config.engineUrls[engine] = cleanUrl;
      }

      await saveModelsConfig(modelsConfigPath, config);
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

      const config = getModelsConfig();
      if (!config) {
        return reply.status(500).send({ error: 'Models config not loaded' });
      }

      if (role === 'embedding') {
        // Unload any omni embedding model
        await OmniModelCache.unloadLlmEmbed();
        config.embeddings[engine] = {
          provider: 'local' as const,
          engine: engine as 'ollama' | 'lmstudio',
          baseUrl,
          model,
        };
        config.embeddings['default'] = engine;
      } else {
        // Unload any omni chat model
        await OmniModelCache.unloadLlmChat();
        // Preserve reasoningBudget and active from the current entry
        const resolvedKey = resolveDefaultName('llm');
        const currentDefault = typeof config.llm[resolvedKey] === 'object' ? config.llm[resolvedKey] as Record<string, any> : null;
        const existingExt = typeof config.llm[engine] === 'object' ? config.llm[engine] as Record<string, any> : null;
        // Preserve all existing config fields (maxTokens, temperature, contextSize, etc.)
        config.llm[engine] = {
          ...(existingExt || {}),
          provider: 'local' as const,
          engine: engine as 'ollama' | 'lmstudio',
          baseUrl,
          model,
          ...(currentDefault?.reasoningBudget != null ? { reasoningBudget: currentDefault.reasoningBudget } : {}),
        };
        config.llm['default'] = engine;
      }

      await saveModelsConfig(modelsConfigPath, config);
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
          const modelConfig = config.llm[engine];
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

      const config = getModelsConfig();
      if (!config) {
        return reply.status(500).send({ error: 'Models config not loaded' });
      }

      // Resolve the default pointer to the actual config entry
      const resolvedKey = resolveDefaultName('llm');
      const defaultModel = config.llm[resolvedKey];
      if (!defaultModel || typeof defaultModel === 'string') {
        return reply.status(400).send({ error: 'No default model configured' });
      }

      // Save to models.yaml
      defaultModel.contextSize = contextSize;
      await saveModelsConfig(modelsConfigPath, config);
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
          } catch {
            logger.warn('[LocalLLM] Failed to probe LM Studio for instance ID');
          }
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

  // GET /status — return status including GPU info from node-omni-orcha
  fastify.get('/status', async () => {
    const omniStatus = OmniModelCache.getStatus();
    const state = await manager.getState();
    const config = getModelsConfig();
    const resolvedKey = resolveDefaultName('llm');
    const defaultModel = config?.llm[resolvedKey];
    const defaultProvider = (defaultModel && typeof defaultModel !== 'string') ? detectProvider(defaultModel) : null;
    const defaultEngine = (defaultModel && typeof defaultModel !== 'string') ? (defaultModel.engine || null) : null;

    const vram = omniStatus.gpu.backend === 'cuda' ? queryNvidiaVram() : null;

    return {
      omni: omniStatus,
      available: true,
      lastActiveModel: state.lastActiveModel,
      systemRamBytes: os.totalmem(),
      freeRamBytes: os.freemem(),
      gpu: omniStatus.gpu,
      vram,
      defaultProvider,
      defaultEngine,
      platform: process.platform,
      arch: process.arch,
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

  // GET /models/download?repo=...&fileName=...&type=gguf|dir|bundle&subdir=...&targetDir=...&files=...&category=...  (SSE stream)
  fastify.get<{ Querystring: { repo: string; fileName?: string; type?: string; subdir?: string; targetDir?: string; files?: string; category?: string } }>(
    '/models/download',
    async (request, reply) => {
      const { repo, fileName, type, subdir, targetDir, files: filesJson, category } = request.query;
      const modelType = category as LocalModel['modelType'] | undefined;
      if (!repo && type !== 'bundle') {
        return reply.status(400).send({ error: 'repo is required' });
      }
      if (type !== 'dir' && type !== 'bundle' && !fileName) {
        return reply.status(400).send({ error: 'fileName is required for single-file downloads' });
      }

      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');

      let clientDisconnected = false;
      reply.raw.on('close', () => { clientDisconnected = true; });

      try {
        let model;

        if (type === 'bundle') {
          // Multi-repo bundle download (e.g. FLUX.2 Klein)
          if (!targetDir || !filesJson) {
            reply.raw.write(`data: ${JSON.stringify({ type: 'error', error: 'targetDir and files required for bundle' })}\n\n`);
            reply.raw.end();
            return;
          }
          const bundleFiles = JSON.parse(filesJson) as Array<{ repo: string; file: string; targetName?: string }>;
          model = await manager.downloadBundle(
            targetDir,
            bundleFiles,
            (progress) => {
              if (!clientDisconnected) {
                reply.raw.write(`data: ${JSON.stringify({ type: 'progress', ...progress })}\n\n`);
              }
            },
            modelType,
          );
        } else if (type === 'dir') {
          // Directory download (multi-file models like TTS)
          model = await manager.downloadDirectory(
            repo,
            (progress) => {
              if (!clientDisconnected) {
                reply.raw.write(`data: ${JSON.stringify({ type: 'progress', ...progress })}\n\n`);
              }
            },
            subdir,
            targetDir,
            modelType,
          );
        } else {
          // Single GGUF file download
          model = await manager.downloadModel(
            repo,
            fileName!,
            (progress) => {
              if (!clientDisconnected) {
                reply.raw.write(`data: ${JSON.stringify({ type: 'progress', ...progress })}\n\n`);
              }
            },
            undefined,
            modelType,
          );

          // Auto-download mmproj for vision models (into the same directory)
          if (!clientDisconnected && !fileName!.toLowerCase().includes('mmproj')) {
            const modelDirName = generateDirName(fileName!);
            if (!clientDisconnected) {
              reply.raw.write(`data: ${JSON.stringify({ type: 'mmproj_start' })}\n\n`);
            }
            try {
              const mmproj = await manager.autoDownloadMmproj(
                repo,
                (progress) => {
                  if (!clientDisconnected) {
                    reply.raw.write(`data: ${JSON.stringify({ type: 'progress', ...progress })}\n\n`);
                  }
                },
                modelDirName,
              );
              if (mmproj && !clientDisconnected) {
                reply.raw.write(`data: ${JSON.stringify({ type: 'mmproj', model: mmproj })}\n\n`);
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              logger.warn(`[LocalLLM] mmproj auto-download failed: ${msg}`);
              if (!clientDisconnected) {
                reply.raw.write(`data: ${JSON.stringify({ type: 'mmproj_error', error: msg })}\n\n`);
              }
            }
          }
        }

        // Auto-configure models.yaml for image/tts bundles after download — only if slot is empty
        if (model && (category === 'image' || category === 'tts')) {
          try {
            const config = getModelsConfig();
            if (config) {
              const modelDir = `.models/${model.fileName}`;
              const hasExistingImage = config.image && Object.values(config.image).some(v => typeof v === 'object' && (v as any).modelPath);
              const hasExistingTts = config.tts && Object.values(config.tts).some(v => typeof v === 'object' && (v as any).modelPath);

              if (category === 'image' && type === 'bundle' && !hasExistingImage) {
                const bundleFiles = JSON.parse(filesJson!) as Array<{ repo: string; file: string; targetName?: string }>;
                const mainFile = bundleFiles[0]!;
                const vaeFile = bundleFiles.find(f => /vae/i.test(f.targetName || f.file));
                const llmFile = bundleFiles.find(f => !(/vae/i.test(f.targetName || f.file)) && f !== mainFile);
                const toFileName = (f: { file: string; targetName?: string }) => f.targetName || f.file.split('/').pop()!;
                config.image = config.image || {};
                config.image['omni'] = {
                  modelPath: `${modelDir}/${toFileName(mainFile)}`,
                  ...(llmFile ? { llm: `${modelDir}/${toFileName(llmFile)}` } : {}),
                  ...(vaeFile ? { vae: `${modelDir}/${toFileName(vaeFile)}` } : {}),
                  steps: 20,
                  description: model.fileName,
                  share: true,
                };
                config.image['default'] = 'omni';
                await saveModelsConfig(modelsConfigPath, config);
                LLMFactory.clearCache();
              } else if (category === 'tts' && !hasExistingTts) {
                config.tts = config.tts || {};
                config.tts['omni'] = {
                  modelPath: modelDir,
                  description: model.fileName,
                  share: true,
                };
                config.tts['default'] = 'omni';
                await saveModelsConfig(modelsConfigPath, config);
                LLMFactory.clearCache();
              }
            }
          } catch (err: any) {
            logger.error('[LocalLLM] Failed to auto-configure models.yaml after download:', err);
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

  // POST /models/:id/activate — load model via OmniModelCache
  fastify.post<{ Params: { id: string } }>(
    '/models/:id/activate',
    async (request, reply) => {
      const model = await manager.getModel(request.params.id);
      if (!model) {
        return reply.status(404).send({ error: 'Model not found' });
      }

      // Read existing config for contextSize and reasoningBudget from the resolved default
      const fullConfig = getModelsConfig();
      const resolvedKey = resolveDefaultName('llm');
      const currentDefault = fullConfig?.llm[resolvedKey];
      const currentObj = (currentDefault && typeof currentDefault !== 'string') ? currentDefault : null;

      // Auto-detect mmproj for vision models
      const mmprojPath = await manager.findMmprojForModel(model.fileName);
      if (mmprojPath) {
        logger.info(`[LocalLLM] Auto-detected mmproj for activation: ${mmprojPath}`);
      }

      try {
        await OmniModelCache.getLlmChat(model.filePath, {
          contextSize: currentObj?.contextSize,
          ...(mmprojPath ? { mmprojPath } : {}),
        });
      } catch (err: any) {
        logger.error('[LocalLLM] Failed to load model:', err);
        return reply.status(500).send({ error: `Failed to load: ${err.message}` });
      }

      const modelName = model.fileName.replace(/\.gguf$/i, '');
      const existingEntry = fullConfig?.llm['omni'];
      const existingObj = (existingEntry && typeof existingEntry !== 'string') ? existingEntry : null;
      // Preserve all existing config fields (maxTokens, temperature, thinkingBudget, etc.)
      // and only override the fields that activation changes (provider, model, contextSize)
      const omniEntry = {
        ...(existingObj || {}),
        provider: 'omni' as const,
        model: modelName,
        ...(currentObj?.contextSize ? { contextSize: currentObj.contextSize } : {}),
        reasoningBudget: currentObj?.reasoningBudget ?? existingObj?.reasoningBudget ?? 0,
      };

      // Update models.yaml — write to omni key and set default pointer
      try {
        const config = getModelsConfig();
        if (config) {
          config.llm['omni'] = omniEntry;
          config.llm['default'] = 'omni';
          await saveModelsConfig(modelsConfigPath, config);
          LLMFactory.clearCache();
        }
      } catch (err: any) {
        logger.error('[LocalLLM] Failed to update models.yaml:', err);
      }

      // Save state
      await manager.saveState({ lastActiveModel: model.id });

      return { ok: true, status: OmniModelCache.getStatus() };
    },
  );

  // GET /models/:id/mmproj — check if model has an mmproj companion
  fastify.get<{ Params: { id: string } }>(
    '/models/:id/mmproj',
    async (request, reply) => {
      const model = await manager.getModel(request.params.id);
      if (!model) {
        return reply.status(404).send({ error: 'Model not found' });
      }
      const mmprojPath = await manager.findMmprojForModel(model.fileName);
      return { hasMmproj: !!mmprojPath, path: mmprojPath, repo: model.repo || null };
    },
  );

  // POST /models/:id/download-mmproj — manually download mmproj for a vision model
  fastify.post<{ Params: { id: string } }>(
    '/models/:id/download-mmproj',
    async (request, reply) => {
      const model = await manager.getModel(request.params.id);
      if (!model) {
        return reply.status(404).send({ error: 'Model not found' });
      }
      if (!model.repo) {
        return reply.status(400).send({ error: 'Model has no repo metadata — cannot look up mmproj' });
      }

      // Check if mmproj already exists
      const existing = await manager.findMmprojForModel(model.fileName);
      if (existing) {
        return { ok: true, alreadyExists: true, path: existing };
      }

      try {
        const dirName = generateDirName(model.fileName);
        const mmproj = await manager.autoDownloadMmproj(model.repo, undefined, dirName);
        if (!mmproj) {
          return reply.status(404).send({ error: 'No mmproj file found in this model\'s HuggingFace repo' });
        }
        return { ok: true, model: mmproj };
      } catch (err: any) {
        logger.error('[LocalLLM] Manual mmproj download failed:', err);
        return reply.status(500).send({ error: `Download failed: ${err.message}` });
      }
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

      try {
        await OmniModelCache.getLlmEmbed(model.filePath);
      } catch (err: any) {
        logger.error('[LocalLLM] Failed to load embedding model:', err);
        return reply.status(500).send({ error: `Failed to load: ${err.message}` });
      }

      // Update models.yaml — write to omni key and set default pointer
      try {
        const config = getModelsConfig();
        if (config) {
          const embModelName = model.fileName.replace(/\.gguf$/i, '');
          config.embeddings['omni'] = {
            provider: 'omni' as const,
            model: embModelName,
          };
          config.embeddings['default'] = 'omni';
          await saveModelsConfig(modelsConfigPath, config);
        }
      } catch (err: any) {
        logger.error('[LocalLLM] Failed to update models.yaml:', err);
      }

      return { ok: true, status: OmniModelCache.getStatus() };
    },
  );

  // POST /models/:id/activate-image — configure + load an image model
  fastify.post<{ Params: { id: string } }>(
    '/models/:id/activate-image',
    async (request, reply) => {
      const model = await manager.getModel(request.params.id);
      if (!model) {
        return reply.status(404).send({ error: 'Model not found' });
      }

      // Scan the model directory to identify main model, vae, and llm companion files
      const modelDir = model.filePath;
      const relDir = `.models/${model.fileName}`;
      let files: string[];
      try {
        files = await fs.readdir(modelDir);
      } catch {
        return reply.status(400).send({ error: 'Model directory not found — expected a bundle directory' });
      }

      const ggufFiles = files.filter(f => f.endsWith('.gguf'));
      const vaeFile = files.find(f => /vae/i.test(f) && f.endsWith('.safetensors'));
      // Main model: match known diffusion model patterns, or directory name, or first gguf
      const mainModel = ggufFiles.find(f => /flux|stable.?diff|sdxl|wan/i.test(f))
        || ggufFiles.find(f => f.toLowerCase().includes(model.fileName.toLowerCase()))
        || ggufFiles[0];
      // Detect T5/UMT5 text encoder vs LLM companion (Qwen3 for FLUX.2)
      const t5Encoder = ggufFiles.find(f => f !== mainModel && /umt5|t5.?xxl/i.test(f));
      const llmCompanion = ggufFiles.find(f => f !== mainModel && f !== t5Encoder);

      if (!mainModel) {
        return reply.status(400).send({ error: 'No .gguf model file found in directory' });
      }

      const modelPath = path.join(modelDir, mainModel);
      try {
        await OmniModelCache.getImageModel(modelPath, {
          ...(t5Encoder ? { t5xxlPath: path.join(modelDir, t5Encoder) } : {}),
          ...(llmCompanion ? { llmPath: path.join(modelDir, llmCompanion) } : {}),
          ...(vaeFile ? { vaePath: path.join(modelDir, vaeFile) } : {}),
        });
      } catch (err: any) {
        logger.error('[LocalLLM] Failed to load image model:', err);
        return reply.status(500).send({ error: `Failed to load: ${err.message}` });
      }

      // Update models.yaml
      try {
        const config = getModelsConfig();
        if (config) {
          config.image = config.image || {};
          config.image['omni'] = {
            modelPath: `${relDir}/${mainModel}`,
            ...(t5Encoder ? { t5xxl: `${relDir}/${t5Encoder}` } : {}),
            ...(llmCompanion ? { llm: `${relDir}/${llmCompanion}` } : {}),
            ...(vaeFile ? { vae: `${relDir}/${vaeFile}` } : {}),
            steps: (config.image['omni'] as any)?.steps ?? 20,
            description: model.fileName,
            share: true,
          };
          config.image['default'] = 'omni';
          await saveModelsConfig(modelsConfigPath, config);
          LLMFactory.clearCache();
        }
      } catch (err: any) {
        logger.error('[LocalLLM] Failed to update models.yaml:', err);
      }

      return { ok: true, status: OmniModelCache.getStatus() };
    },
  );

  // POST /models/:id/activate-tts — configure + load a TTS model
  fastify.post<{ Params: { id: string } }>(
    '/models/:id/activate-tts',
    async (request, reply) => {
      const model = await manager.getModel(request.params.id);
      if (!model) {
        return reply.status(404).send({ error: 'Model not found' });
      }

      const modelPath = model.filePath;
      try {
        await OmniModelCache.getTtsModel(modelPath);
      } catch (err: any) {
        logger.error('[LocalLLM] Failed to load TTS model:', err);
        return reply.status(500).send({ error: `Failed to load: ${err.message}` });
      }

      // Update models.yaml
      try {
        const config = getModelsConfig();
        if (config) {
          config.tts = config.tts || {};
          config.tts['omni'] = {
            modelPath: `.models/${model.fileName}`,
            description: model.fileName,
            share: true,
          };
          config.tts['default'] = 'omni';
          await saveModelsConfig(modelsConfigPath, config);
          LLMFactory.clearCache();
        }
      } catch (err: any) {
        logger.error('[LocalLLM] Failed to update models.yaml:', err);
      }

      return { ok: true, status: OmniModelCache.getStatus() };
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

      // Don't delete if currently loaded in OmniModelCache
      const status = OmniModelCache.getStatus();
      if (status.llmChat.modelPath === model.filePath) {
        return reply.status(409).send({ error: 'Cannot delete the currently active model. Stop it first.' });
      }
      if (status.llmEmbed.modelPath === model.filePath) {
        return reply.status(409).send({ error: 'Cannot delete the active embedding model. Stop it first.' });
      }

      await manager.deleteModel(request.params.id);
      return { ok: true };
    },
  );

  // GET /browse?q=...&limit=10
  fastify.get<{ Querystring: { q: string; limit?: string } }>(
    '/browse',
    async (request, reply) => {
      const { q, limit } = request.query;
      if (!q) {
        return reply.status(400).send({ error: 'q (query) is required' });
      }
      return manager.browseHuggingFace(q, Number(limit) || 10);
    },
  );

  // POST /stop — unload omni chat model
  fastify.post('/stop', async () => {
    await OmniModelCache.unloadLlmChat();
    return { ok: true };
  });

  // POST /stop-embedding — unload omni embedding model
  fastify.post('/stop-embedding', async () => {
    await OmniModelCache.unloadLlmEmbed();
    return { ok: true };
  });

  // POST /stop-image — unload omni image model
  fastify.post('/stop-image', async () => {
    await OmniModelCache.unloadImage();
    return { ok: true };
  });

  // POST /stop-tts — unload omni TTS model
  fastify.post('/stop-tts', async () => {
    await OmniModelCache.unloadTts();
    return { ok: true };
  });

  // POST /start-embedding — pre-load the configured omni embedding model
  fastify.post('/start-embedding', async (_req, reply) => {
    const config = getModelsConfig();
    let embName = config?.embeddings?.['default'];
    if (typeof embName === 'string') embName = config?.embeddings?.[embName];
    const embConfig = typeof embName === 'object' ? embName : null;
    if (!embConfig?.model) return reply.status(400).send({ error: 'No omni embedding model configured' });
    const provider = detectProvider(embConfig as any);
    if (provider !== 'omni') return reply.status(400).send({ error: `Embedding provider is "${provider}", not omni` });

    const modelsDir = path.join(workspaceRoot, '.models');
    const modelPath = await resolveModelFile(modelsDir, embConfig.model);
    await OmniModelCache.getLlmEmbed(modelPath);
    return { ok: true, status: OmniModelCache.getStatus() };
  });

  // POST /start-image — pre-load the first configured image model
  fastify.post('/start-image', async (_req, reply) => {
    const configs = listImageConfigs();
    const first = configs[0];
    if (!first) return reply.status(400).send({ error: 'No image model configured in models.yaml' });
    if (!first.config.modelPath) return reply.status(400).send({ error: 'Image config has no modelPath' });

    const resolve = (p?: string) => p ? (path.isAbsolute(p) ? p : path.join(workspaceRoot, p)) : undefined;
    const modelPath = resolve(first.config.modelPath)!;
    await OmniModelCache.getImageModel(modelPath, {
      ...(first.config.clipL ? { clipLPath: resolve(first.config.clipL) } : {}),
      ...(first.config.t5xxl ? { t5xxlPath: resolve(first.config.t5xxl) } : {}),
      ...(first.config.llm ? { llmPath: resolve(first.config.llm) } : {}),
      ...(first.config.vae ? { vaePath: resolve(first.config.vae) } : {}),
    });
    return { ok: true, status: OmniModelCache.getStatus() };
  });

  // POST /start-tts — pre-load the first configured TTS model
  fastify.post('/start-tts', async (_req, reply) => {
    const configs = listTtsConfigs();
    const first = configs[0];
    if (!first) return reply.status(400).send({ error: 'No TTS model configured in models.yaml' });
    const modelPath = path.isAbsolute(first.config.modelPath) ? first.config.modelPath : path.join(workspaceRoot, first.config.modelPath);
    await OmniModelCache.getTtsModel(modelPath);
    return { ok: true, status: OmniModelCache.getStatus() };
  });

};
