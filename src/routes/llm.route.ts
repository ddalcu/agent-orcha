import type { FastifyPluginAsync } from 'fastify';
import {
  LLMFactory,
  listModelConfigs, getModelConfig,
  listEmbeddingConfigs, getEmbeddingConfig,
  resolveApiKey,
  getLLMConfig, saveLLMConfig,
} from '../../lib/llm/index.ts';
import { ModelConfigSchema, EmbeddingModelConfigSchema } from '../../lib/llm/llm-config.ts';
import { detectProvider } from '../../lib/llm/provider-detector.ts';
import { ModelManager } from '../../lib/local-llm/index.ts';
import { humanMessage, aiMessage } from '../../lib/types/llm-types.ts';
import type { MessageContent, ContentPart } from '../../lib/types/llm-types.ts';
import { logger } from '../../lib/logger.ts';
import { extractDocumentText } from '../../lib/utils/document-extract.ts';

const PROVIDER_ENV_VARS: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  gemini: 'GOOGLE_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  local: 'OPENAI_API_KEY',
};

function redactKey(key?: string): string | undefined {
  if (!key) return undefined;
  if (/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(key)) return key;
  return key.length > 4 ? `••••${key.slice(-4)}` : '••••';
}

interface LLMParams {
  name: string;
}

interface Attachment {
  data: string;
  mediaType: string;
  name?: string;
}

interface ChatBody {
  message: string;
  sessionId?: string;
  attachments?: Attachment[];
}

async function buildUserContent(text: string, attachments?: Attachment[]): Promise<MessageContent> {
  if (!Array.isArray(attachments) || attachments.length === 0) return text;

  const parts: ContentPart[] = [];
  if (text) parts.push({ type: 'text', text });
  for (const att of attachments) {
    if (!att || typeof att.data !== 'string' || typeof att.mediaType !== 'string') continue;

    if (att.mediaType.startsWith('image/')) {
      parts.push({ type: 'image', data: att.data, mediaType: att.mediaType });
    } else {
      try {
        const doc = await extractDocumentText(att.data, att.mediaType, att.name);
        const label = att.name ? `[File: ${att.name}]` : `[Attached ${doc.format} document]`;
        parts.push({ type: 'text', text: `${label}\n${doc.text}` });
      } catch (err: any) {
        parts.push({ type: 'text', text: `[Failed to extract ${att.name ?? 'attachment'}: ${err.message}]` });
      }
    }
  }
  return parts.length > 0 ? parts : text;
}

async function checkConfigReady(
  config: { provider?: string; baseUrl?: string; apiKey?: string; model: string },
  manager: ModelManager,
): Promise<{ ready: boolean; reason?: string }> {
  const provider = detectProvider(config as any);
  if (provider === 'local' && !config.baseUrl) {
    const filePath = await manager.findModelFile(config.model);
    if (!filePath) return { ready: false, reason: `Model "${config.model}" not downloaded` };
  } else if (provider !== 'local') {
    const key = resolveApiKey(provider, config.apiKey);
    if (!key) return { ready: false, reason: `No API key for ${provider}` };
  }
  return { ready: true };
}

export const llmRoutes: FastifyPluginAsync = async (fastify) => {
  const manager = new ModelManager(fastify.orchestrator.workspaceRoot);
  const llmJsonPath = fastify.orchestrator.llmConfigPath;

  // GET /config — full llm.json with redacted API keys + env var info
  fastify.get('/config', async () => {
    const config = getLLMConfig();
    if (!config) return { version: '1.0', models: {}, embeddings: {} };

    const models: Record<string, any> = {};
    for (const [name, m] of Object.entries(config.models)) {
      const provider = detectProvider(m);
      const envVar = PROVIDER_ENV_VARS[provider];
      models[name] = {
        ...m,
        apiKey: redactKey(m.apiKey),
        _provider: provider,
        _hasEnvKey: !!(envVar && process.env[envVar]),
        _envVar: envVar,
      };
    }

    const embeddings: Record<string, any> = {};
    for (const [name, e] of Object.entries(config.embeddings)) {
      embeddings[name] = {
        ...e,
        apiKey: redactKey(e.apiKey),
      };
    }

    return { version: config.version, models, embeddings };
  });

  // PUT /config/models/:name — upsert a model config entry
  fastify.put<{ Params: { name: string }; Body: any }>(
    '/config/models/:name',
    async (request) => {
      const config = getLLMConfig();
      if (!config) throw new Error('No llm.json loaded');

      const { name } = request.params;
      const body = { ...request.body };

      // Strip internal fields
      delete body._provider;
      delete body._hasEnvKey;
      delete body._envVar;

      // Preserve existing API key if redacted or empty
      const existing = config.models[name];
      if (!body.apiKey || body.apiKey.startsWith('••••')) {
        if (existing?.apiKey) {
          body.apiKey = existing.apiKey;
        } else {
          delete body.apiKey;
        }
      }

      // Remove empty optional fields
      if (!body.baseUrl) delete body.baseUrl;
      if (body.temperature == null) delete body.temperature;
      if (body.maxTokens == null) delete body.maxTokens;
      if (body.thinkingBudget == null) delete body.thinkingBudget;
      if (body.reasoningBudget == null) delete body.reasoningBudget;
      if (body.contextSize == null) delete body.contextSize;

      config.models[name] = ModelConfigSchema.parse(body);
      await saveLLMConfig(llmJsonPath, config);
      LLMFactory.clearCache();

      return { ok: true };
    },
  );

  // DELETE /config/models/:name — delete a model config entry
  fastify.delete<{ Params: { name: string } }>(
    '/config/models/:name',
    async (request, reply) => {
      const config = getLLMConfig();
      if (!config) throw new Error('No llm.json loaded');

      const { name } = request.params;
      if (name === 'default') {
        return reply.status(400).send({ error: 'Cannot delete the default model config' });
      }

      delete config.models[name];
      await saveLLMConfig(llmJsonPath, config);
      LLMFactory.clearCache();

      return { ok: true };
    },
  );

  // PUT /config/embeddings/:name — upsert an embedding config entry
  fastify.put<{ Params: { name: string }; Body: any }>(
    '/config/embeddings/:name',
    async (request) => {
      const config = getLLMConfig();
      if (!config) throw new Error('No llm.json loaded');

      const { name } = request.params;
      const body = { ...request.body };

      const existing = config.embeddings[name];
      if (!body.apiKey || body.apiKey.startsWith('••••')) {
        if (existing?.apiKey) {
          body.apiKey = existing.apiKey;
        } else {
          delete body.apiKey;
        }
      }

      if (!body.baseUrl) delete body.baseUrl;
      if (body.dimensions == null) delete body.dimensions;

      config.embeddings[name] = EmbeddingModelConfigSchema.parse(body);
      await saveLLMConfig(llmJsonPath, config);

      return { ok: true };
    },
  );

  // GET /readiness — check if default model + embedding are usable
  fastify.get('/readiness', async () => {
    const issues: string[] = [];

    if (listModelConfigs().includes('default')) {
      const result = await checkConfigReady(getModelConfig('default'), manager);
      if (!result.ready) issues.push(`Chat: ${result.reason}`);
    } else {
      issues.push('No default model configured');
    }

    if (listEmbeddingConfigs().includes('default')) {
      const result = await checkConfigReady(getEmbeddingConfig('default'), manager);
      if (!result.ready) issues.push(`Embedding: ${result.reason}`);
    } else {
      issues.push('No default embedding configured');
    }

    return { ready: issues.length === 0, issues };
  });

  // List all available LLM configs
  fastify.get('/', async () => {
    const names = listModelConfigs();
    return names.map((name) => {
      const config = getModelConfig(name);
      return {
        name,
        model: config.model,
        temperature: config.temperature,
        baseUrl: config.baseUrl || null,
      };
    });
  });

  // Get a specific LLM config
  fastify.get<{ Params: LLMParams }>('/:name', async (request, reply) => {
    try {
      const config = getModelConfig(request.params.name);
      return {
        name: request.params.name,
        model: config.model,
        temperature: config.temperature,
        baseUrl: config.baseUrl || null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(404).send({ error: message });
    }
  });

  // Chat with a specific LLM
  fastify.post<{ Params: LLMParams; Body: ChatBody }>(
    '/:name/chat',
    async (request, reply) => {
      const { name } = request.params;
      const { message, sessionId, attachments } = request.body;

      if (!message || typeof message !== 'string') {
        return reply.status(400).send({ error: 'message is required' });
      }

      const taskManager = fastify.orchestrator.tasks.getManager();
      const task = taskManager.track('llm', name, { message });

      try {
        const store = fastify.orchestrator.memory.getStore();
        const history = sessionId ? store.getMessages(sessionId) : [];
        const userContent = await buildUserContent(message, attachments);
        const messages = [...history, humanMessage(userContent)];

        const llm = await LLMFactory.create(name);
        const response = await llm.invoke(messages);

        // Store messages (text-only user message, no base64 in memory)
        if (sessionId) {
          store.addMessage(sessionId, humanMessage(message));
          store.addMessage(sessionId, aiMessage(typeof response.content === 'string' ? response.content : ''));
        }

        const result = {
          output: response.content,
          model: name,
          metadata: {
            temperature: getModelConfig(name).temperature,
          },
        };

        taskManager.resolve(task.id, result);
        return result;
      } catch (error: any) {
        logger.error('[LLM Route] Error invoking LLM:', error);
        const message = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        fastify.log.error({ error, stack }, 'LLM invocation error');
        taskManager.reject(task.id, error);

        // Handle rate limiting errors with better messages
        if (error.status === 429 || message.includes('quota') || message.includes('rate limit')) {
          return reply.status(429).send({
            error: 'Rate limit or quota exceeded. Please wait and try again, or check your API quota limits.'
          });
        }

        return reply.status(error.status || 500).send({ error: message });
      }
    }
  );

  // Stream chat with a specific LLM
  fastify.post<{ Params: LLMParams; Body: ChatBody }>(
    '/:name/stream',
    async (request, reply) => {
      const { name } = request.params;
      const { message, sessionId, attachments } = request.body;

      if (!message || typeof message !== 'string') {
        return reply.status(400).send({ error: 'message is required' });
      }

      const taskManager = fastify.orchestrator.tasks.getManager();
      const task = taskManager.track('llm', name, { message });

      // Create an AbortController that cancels the LLM stream on client disconnect or task cancel
      const abortController = new AbortController();
      taskManager.registerAbort(task.id, abortController);

      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');

      // Abort the LLM stream when the client disconnects (socket close, not request body close)
      reply.raw.on('close', () => {
        if (!abortController.signal.aborted) {
          abortController.abort();
        }
      });

      try {
        const store = fastify.orchestrator.memory.getStore();
        const history = sessionId ? store.getMessages(sessionId) : [];
        const userContent = await buildUserContent(message, attachments);
        const messages = [...history, humanMessage(userContent)];

        // Store text-only user message (no base64 in memory)
        if (sessionId) store.addMessage(sessionId, humanMessage(message));

        const llm = await LLMFactory.create(name);
        const stream = await llm.stream(messages, { signal: abortController.signal });

        let lastChunk: any = null;
        let accumulated = '';
        for await (const chunk of stream) {
          if (abortController.signal.aborted) break;
          lastChunk = chunk;
          const content = chunk.content;
          if (content) {
            accumulated += content;
            reply.raw.write(`data: ${JSON.stringify({ content })}\n\n`);
          }
          if (chunk.reasoning) {
            reply.raw.write(`data: ${JSON.stringify({ type: 'thinking', content: chunk.reasoning })}\n\n`);
          }
        }

        if (!abortController.signal.aborted) {
          // Store AI response in conversation history
          if (sessionId && accumulated) {
            store.addMessage(sessionId, aiMessage(accumulated));
          }

          // Send usage stats from the final chunk if available
          if (lastChunk?.usage_metadata) {
            const um = lastChunk.usage_metadata;
            reply.raw.write(`data: ${JSON.stringify({
              type: 'usage',
              input_tokens: um.input_tokens ?? 0,
              output_tokens: um.output_tokens ?? 0,
              total_tokens: um.total_tokens ?? 0,
            })}\n\n`);
          }

          taskManager.resolve(task.id, { output: 'stream completed', model: name });
          reply.raw.write('data: [DONE]\n\n');
        }
        reply.raw.end();
      } catch (error) {
        if (abortController.signal.aborted) {
          reply.raw.end();
          return;
        }
        logger.error('[LLM Route] Error streaming LLM:', error);
        const message = error instanceof Error ? error.message : String(error);
        fastify.log.error({ error }, 'LLM streaming error');
        taskManager.reject(task.id, error);
        reply.raw.write(`data: ${JSON.stringify({ error: message })}\n\n`);
        reply.raw.end();
      } finally {
        taskManager.unregisterAbort(task.id);
      }
    }
  );
};
