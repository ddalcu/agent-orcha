import * as os from 'os';
import type { FastifyPluginAsync } from 'fastify';
import { ModelManager } from '../../lib/local-llm/index.ts';
import { llamaEngine, llamaEmbeddingEngine } from '../../lib/local-llm/llama-provider.ts';
import {
  getLLMConfig,
  saveLLMConfig,
  LLMFactory,
} from '../../lib/llm/index.ts';
import { detectProvider } from '../../lib/llm/provider-detector.ts';
import { getBinaryVersion, isSystemBinary, updateBinary, checkForUpdate } from '../../lib/local-llm/binary-manager.ts';
import { logger } from '../../lib/logger.ts';

export const localLlmRoutes: FastifyPluginAsync = async (fastify) => {
  const workspaceRoot = fastify.orchestrator.workspaceRoot;
  const manager = new ModelManager(workspaceRoot);
  const llmJsonPath = fastify.orchestrator.llmConfigPath;

  // GET /status
  fastify.get('/status', async () => {
    const status = llamaEngine.getStatus();
    const embeddingStatus = llamaEmbeddingEngine.getStatus();
    const state = await manager.getState();
    const config = getLLMConfig();
    const defaultModel = config?.models['default'];
    const defaultProvider = defaultModel ? detectProvider(defaultModel) : null;
    return {
      ...status,
      available: true,
      lastActiveModel: state.lastActiveModel,
      embedding: embeddingStatus,
      systemRamBytes: os.totalmem(),
      freeRamBytes: os.freemem(),
      defaultProvider,
      platform: process.platform,
      llamaVersion: getBinaryVersion(workspaceRoot),
      binarySource: isSystemBinary() ? 'system' : 'managed',
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

  // GET /models/download?repo=...&fileName=...  (SSE stream)
  fastify.get<{ Querystring: { repo: string; fileName: string } }>(
    '/models/download',
    async (request, reply) => {
      const { repo, fileName } = request.query;
      if (!repo || !fileName) {
        return reply.status(400).send({ error: 'repo and fileName are required' });
      }

      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');

      let clientDisconnected = false;
      reply.raw.on('close', () => { clientDisconnected = true; });

      try {
        const model = await manager.downloadModel(
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

  // POST /models/:id/activate
  fastify.post<{ Params: { id: string }; Body: { setAsDefault?: boolean } }>(
    '/models/:id/activate',
    async (request, reply) => {
      const model = await manager.getModel(request.params.id);
      if (!model) {
        return reply.status(404).send({ error: 'Model not found' });
      }

      // Read existing config for contextSize and reasoningBudget
      const currentDefault = getLLMConfig()?.models['default'];

      try {
        await llamaEngine.swap(model.filePath, {
          ...(currentDefault?.contextSize !== undefined ? { contextSize: currentDefault.contextSize } : {}),
          ...(currentDefault?.reasoningBudget !== undefined ? { reasoningBudget: currentDefault.reasoningBudget } : {}),
        });
      } catch (err: any) {
        logger.error('[LocalLLM] Failed to load model:', err);
        return reply.status(500).send({ error: `Failed to load: ${err.message}` });
      }

      const setAsDefault = (request.body as any)?.setAsDefault === true;
      const detectedCtx = llamaEngine.getStatus().contextSize;
      const localLlamaEntry = {
        provider: 'local' as const,
        model: model.fileName.replace(/\.gguf$/i, ''),
        ...(detectedCtx ? { contextSize: detectedCtx } : {}),
        reasoningBudget: currentDefault?.reasoningBudget ?? 0,
      };

      // Update llm.json
      try {
        const config = getLLMConfig();
        if (config) {
          if (setAsDefault) {
            const existing = config.models['default'];
            if (existing && existing.provider !== 'local') {
              config.models['default_old'] = existing;
            }
            config.models['default'] = localLlamaEntry;
          } else {
            config.models['local-llama'] = localLlamaEntry;
          }
          await saveLLMConfig(llmJsonPath, config);
          LLMFactory.clearCache();
        }
      } catch (err: any) {
        logger.error('[LocalLLM] Failed to update llm.json:', err);
      }

      // Save state
      await manager.saveState({ lastActiveModel: model.id });

      return { ok: true, status: llamaEngine.getStatus() };
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
        await llamaEmbeddingEngine.load(model.filePath);
      } catch (err: any) {
        logger.error('[LocalLLM] Failed to load embedding model:', err);
        return reply.status(500).send({ error: `Failed to load: ${err.message}` });
      }

      // Update llm.json — write a "local-embedding" entry
      try {
        const config = getLLMConfig();
        if (config) {
          config.embeddings['default'] = {
            provider: 'local' as const,
            model: model.fileName.replace(/\.gguf$/i, ''),
          };
          await saveLLMConfig(llmJsonPath, config);
        }
      } catch (err: any) {
        logger.error('[LocalLLM] Failed to update llm.json:', err);
      }

      return { ok: true, status: llamaEmbeddingEngine.getStatus() };
    },
  );

  // DELETE /models/:id
  fastify.delete<{ Params: { id: string } }>(
    '/models/:id',
    async (request, reply) => {
      const status = llamaEngine.getStatus();
      const model = await manager.getModel(request.params.id);
      if (!model) {
        return reply.status(404).send({ error: 'Model not found' });
      }

      // Don't delete if currently active (chat or embedding)
      if (status.running && status.activeModel === model.filePath) {
        return reply.status(409).send({ error: 'Cannot delete the currently active model. Stop it first.' });
      }
      const embStatus = llamaEmbeddingEngine.getStatus();
      if (embStatus.running && embStatus.activeModel === model.filePath) {
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

  // POST /stop
  fastify.post('/stop', async () => {
    await llamaEngine.unload();
    return { ok: true };
  });

  // POST /stop-embedding
  fastify.post('/stop-embedding', async () => {
    await llamaEmbeddingEngine.unload();
    return { ok: true };
  });

  // GET /check-update — compare local build with latest GitHub release
  fastify.get('/check-update', async () => {
    return checkForUpdate(workspaceRoot);
  });

  // POST /update-binary — pull latest llama-server from GitHub
  fastify.post('/update-binary', async (_request, reply) => {
    if (isSystemBinary()) {
      return reply.status(400).send({ error: 'llama-server is system-installed. Update it via your package manager.' });
    }
    if (llamaEngine.getStatus().running) await llamaEngine.unload();
    if (llamaEmbeddingEngine.getStatus().running) await llamaEmbeddingEngine.unload();
    await updateBinary(workspaceRoot);
    return { ok: true, version: getBinaryVersion(workspaceRoot) };
  });
};
