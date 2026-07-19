import type { FastifyPluginAsync } from 'fastify';
import {
  LLMFactory,
  listModelConfigs, getModelConfig,
  getEmbeddingConfig,
  resolveApiKey,
  getModelsConfig, saveModelsConfig,
  resolveDefaultName,
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
  openrouter: 'OPENROUTER_API_KEY',
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

interface ProviderModel {
  id: string;
  type?: 'chat' | 'embedding' | 'image' | 'audio' | 'video' | 'unknown';
  contextLength?: number;
  description?: string;
}

interface ListModelsResult {
  models: ProviderModel[];
  warning?: string;
}

function classifyModelId(id: string): ProviderModel['type'] {
  const s = id.toLowerCase();
  if (/embed|nomic|bge-|gte-|minilm|e5-/.test(s)) return 'embedding';
  if (/whisper|tts|audio|transcrib/.test(s)) return 'audio';
  if (/dall-?e|stable-?diffusion|flux|sdxl|imagen|midjourney/.test(s)) return 'image';
  if (/video|wan2|sora|veo/.test(s)) return 'video';
  return 'chat';
}

// Normalize an OpenAI-compatible base URL to the /models endpoint.
// Accepts both styles: with or without a trailing /v1 path segment.
function openAiModelsUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '');
  if (/\/v\d+$/.test(trimmed)) return `${trimmed}/models`;
  return `${trimmed}/v1/models`;
}

async function fetchWithTimeout(url: string, init: RequestInit, ms = 10_000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function listProviderModels(provider: string, apiKey: string, baseUrl: string): Promise<ListModelsResult> {
  const needsKey = provider !== 'openai-compat' || !!baseUrl;
  if (!apiKey && (provider === 'openai' || provider === 'anthropic' || provider === 'gemini')) {
    throw new Error('Missing API key');
  }
  if (provider === 'openai-compat' && !baseUrl) {
    throw new Error('Base URL is required for custom OpenAI-compatible endpoints');
  }

  if (provider === 'openai') {
    const url = openAiModelsUrl(baseUrl || 'https://api.openai.com');
    const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`);
    const json: any = await res.json();
    const models: ProviderModel[] = (json.data || []).map((m: any) => ({
      id: m.id,
      type: classifyModelId(m.id),
    }));
    return { models };
  }

  if (provider === 'openrouter') {
    const base = baseUrl || 'https://openrouter.ai/api/v1';
    // OpenRouter's /models endpoint is PUBLIC — calling it with a bad key still returns 200.
    // To actually validate the key, hit /auth/key which requires authentication.
    if (apiKey) {
      const authRes = await fetchWithTimeout(`${base}/auth/key`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!authRes.ok) {
        throw new Error(`${authRes.status} ${authRes.statusText}: ${(await authRes.text()).slice(0, 200)}`);
      }
    }
    const headers: Record<string, string> = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const res = await fetchWithTimeout(`${base}/models`, { headers });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`);
    const json: any = await res.json();
    const models: ProviderModel[] = (json.data || []).map((m: any) => ({
      id: m.id,
      type: classifyModelId(m.id),
      contextLength: m.context_length,
      description: m.name || m.description,
    }));
    return {
      models,
      ...(apiKey ? {} : { warning: 'No API key provided — listing public model catalog. Add a key to use the models.' }),
    };
  }

  if (provider === 'anthropic') {
    const url = `${baseUrl || 'https://api.anthropic.com'}/v1/models`;
    const res = await fetchWithTimeout(url, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`);
    const json: any = await res.json();
    const models: ProviderModel[] = (json.data || []).map((m: any) => ({
      id: m.id,
      type: 'chat' as const,
      description: m.display_name,
    }));
    return { models };
  }

  if (provider === 'gemini') {
    const base = baseUrl || 'https://generativelanguage.googleapis.com';
    const url = `${base}/v1beta/models?key=${encodeURIComponent(apiKey)}`;
    const res = await fetchWithTimeout(url, {});
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`);
    const json: any = await res.json();
    const models: ProviderModel[] = (json.models || []).map((m: any) => {
      const id = (m.name || '').replace(/^models\//, '');
      const methods: string[] = m.supportedGenerationMethods || [];
      let type: ProviderModel['type'] = 'chat';
      if (methods.includes('embedContent') || /embed/.test(id)) type = 'embedding';
      else if (/imagen|image-/.test(id)) type = 'image';
      else if (/veo|video/.test(id)) type = 'video';
      return {
        id,
        type,
        contextLength: m.inputTokenLimit,
        description: m.displayName,
      };
    });
    return { models };
  }

  // Custom OpenAI-compatible endpoint (Groq, Together, DeepInfra, vLLM, etc.)
  if (provider === 'openai-compat' || provider === 'local') {
    if (!baseUrl) throw new Error('Base URL is required');
    const url = openAiModelsUrl(baseUrl);
    const headers: Record<string, string> = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const res = await fetchWithTimeout(url, { headers });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`);
    const json: any = await res.json();
    const models: ProviderModel[] = (json.data || []).map((m: any) => ({
      id: m.id,
      type: classifyModelId(m.id),
    }));
    return { models };
  }

  // Suppress unused warning for needsKey on providers that don't use it
  void needsKey;
  throw new Error(`Unsupported provider: ${provider}`);
}

async function checkConfigReady(
  config: { provider?: string; baseUrl?: string; apiKey?: string; model: string; active?: boolean },
  manager: ModelManager,
): Promise<{ ready: boolean; reason?: string }> {
  if (config.active === false) {
    return { ready: false, reason: `Model "${config.model}" is not active` };
  }
  const provider = detectProvider(config as any);
  if (provider === 'omni' || (provider === 'local' && !config.baseUrl)) {
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
  const modelsConfigPath = fastify.orchestrator.modelsConfigPath;

  // GET /config — full models config with redacted API keys + env var info
  fastify.get('/config', async () => {
    const config = getModelsConfig();
    if (!config) return { version: '1.0', llm: {}, embeddings: {} };

    const llmModels: Record<string, any> = {};
    for (const [name, m] of Object.entries(config.llm)) {
      if (typeof m === 'string') {
        llmModels[name] = m;
        continue;
      }
      const provider = detectProvider(m);
      const envVar = PROVIDER_ENV_VARS[provider];
      llmModels[name] = {
        ...m,
        apiKey: redactKey(m.apiKey),
        _provider: provider,
        _hasEnvKey: !!(envVar && process.env[envVar]),
        _envVar: envVar,
      };
    }

    const embeddings: Record<string, any> = {};
    for (const [name, e] of Object.entries(config.embeddings)) {
      if (typeof e === 'string') {
        embeddings[name] = e;
        continue;
      }
      embeddings[name] = {
        ...e,
        apiKey: redactKey(e.apiKey),
      };
    }

    return {
      version: config.version,
      llm: llmModels,
      embeddings,
      ...(config.image ? { image: config.image } : {}),
      ...(config.video ? { video: config.video } : {}),
      ...(config.tts ? { tts: config.tts } : {}),
    };
  });

  // PUT /config/models/:name — upsert a model config entry (or set pointer for 'default')
  fastify.put<{ Params: { name: string }; Body: any }>(
    '/config/models/:name',
    async (request) => {
      const config = getModelsConfig();
      if (!config) throw new Error('No models config loaded');

      const { name } = request.params;
      const body: Record<string, any> = { ...(request.body as Record<string, any>) };

      // If writing a string pointer (e.g. setting default to a key name)
      if (typeof request.body === 'string' || (typeof body._pointer === 'string')) {
        const pointer = typeof request.body === 'string' ? request.body : body._pointer;
        config.llm[name] = pointer;
        await saveModelsConfig(modelsConfigPath, config);
        LLMFactory.clearCache();
        return { ok: true };
      }

      // Strip internal fields
      delete body._provider;
      delete body._hasEnvKey;
      delete body._envVar;
      delete body._pointer;

      // Preserve existing API key if redacted or empty
      const existing = config.llm[name];
      const existingObj = (existing && typeof existing !== 'string') ? existing : null;
      if (!body.apiKey || body.apiKey.startsWith('••••')) {
        if (existingObj?.apiKey) {
          body.apiKey = existingObj.apiKey;
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

      // Preserve active and share flags from existing entry if not provided
      if (body.active == null && existingObj?.active != null) {
        body.active = existingObj.active;
      }
      if (body.share == null && existingObj?.share != null) {
        body.share = existingObj.share;
      }

      config.llm[name] = ModelConfigSchema.parse(body);
      await saveModelsConfig(modelsConfigPath, config);
      LLMFactory.clearCache();

      return { ok: true };
    },
  );

  // PATCH /config/models/:name/active — toggle active flag
  fastify.patch<{ Params: { name: string }; Body: { active: boolean } }>(
    '/config/models/:name/active',
    async (request, reply) => {
      const config = getModelsConfig();
      if (!config) throw new Error('No models config loaded');

      const { name } = request.params;
      const { active } = request.body as any;
      const entry = config.llm[name];
      if (!entry || typeof entry === 'string') {
        return reply.status(404).send({ error: `Model "${name}" not found` });
      }

      entry.active = active;
      await saveModelsConfig(modelsConfigPath, config);
      LLMFactory.clearCache();

      return { ok: true };
    },
  );

  // PATCH /config/models/:name/share — toggle share flag for LLM models
  fastify.patch<{ Params: { name: string }; Body: { share: boolean } }>(
    '/config/models/:name/share',
    async (request, reply) => {
      const config = getModelsConfig();
      if (!config) throw new Error('No models config loaded');

      const { name } = request.params;
      const { share } = request.body as any;
      const entry = config.llm[name];
      if (!entry || typeof entry === 'string') {
        return reply.status(404).send({ error: `Model "${name}" not found` });
      }

      entry.share = share;
      await saveModelsConfig(modelsConfigPath, config);

      // Broadcast updated catalog so peers see the change
      const manager = (fastify.orchestrator as any)._p2pManager;
      manager?.broadcastCatalog();

      return { ok: true };
    },
  );

  // PATCH /config/:section/:name/share — toggle share flag for image/tts/video models
  fastify.patch<{ Params: { section: string; name: string }; Body: { share: boolean } }>(
    '/config/:section/:name/share',
    async (request, reply) => {
      const config = getModelsConfig();
      if (!config) throw new Error('No models config loaded');

      const { section, name } = request.params;
      if (!['image', 'tts', 'video'].includes(section)) {
        return reply.status(400).send({ error: `Invalid section "${section}". Must be image, tts, or video.` });
      }

      const sectionData = config[section as 'image' | 'tts' | 'video'];
      if (!sectionData) return reply.status(404).send({ error: `No ${section} config found` });

      const entry = sectionData[name];
      if (!entry || typeof entry === 'string') {
        return reply.status(404).send({ error: `${section} model "${name}" not found` });
      }

      (entry as any).share = (request.body as any).share;
      await saveModelsConfig(modelsConfigPath, config);

      const manager = (fastify.orchestrator as any)._p2pManager;
      manager?.broadcastCatalog();

      return { ok: true };
    },
  );

  // DELETE /config/models/:name — delete a model config entry
  fastify.delete<{ Params: { name: string } }>(
    '/config/models/:name',
    async (request, reply) => {
      const config = getModelsConfig();
      if (!config) throw new Error('No models config loaded');

      const { name } = request.params;
      if (name === 'default') {
        return reply.status(400).send({ error: 'Cannot delete the default pointer' });
      }
      // Prevent deleting the entry that default currently points to
      const defaultTarget = resolveDefaultName('llm');
      if (name === defaultTarget) {
        return reply.status(400).send({ error: `Cannot delete "${name}" — it is the current default. Change the default first.` });
      }

      delete config.llm[name];
      await saveModelsConfig(modelsConfigPath, config);
      LLMFactory.clearCache();

      return { ok: true };
    },
  );

  // PUT /config/embeddings/:name — upsert an embedding config entry (or set pointer)
  fastify.put<{ Params: { name: string }; Body: any }>(
    '/config/embeddings/:name',
    async (request) => {
      const config = getModelsConfig();
      if (!config) throw new Error('No models config loaded');

      const { name } = request.params;
      const body: Record<string, any> = { ...(request.body as Record<string, any>) };

      // If writing a string pointer
      if (typeof request.body === 'string' || (typeof body._pointer === 'string')) {
        const pointer = typeof request.body === 'string' ? request.body : body._pointer;
        config.embeddings[name] = pointer;
        await saveModelsConfig(modelsConfigPath, config);
        return { ok: true };
      }

      const existing = config.embeddings[name];
      const existingObj = (existing && typeof existing !== 'string') ? existing : null;
      if (!body.apiKey || body.apiKey.startsWith('••••')) {
        if (existingObj?.apiKey) {
          body.apiKey = existingObj.apiKey;
        } else {
          delete body.apiKey;
        }
      }

      if (!body.baseUrl) delete body.baseUrl;
      if (body.dimensions == null) delete body.dimensions;

      config.embeddings[name] = EmbeddingModelConfigSchema.parse(body);
      await saveModelsConfig(modelsConfigPath, config);

      return { ok: true };
    },
  );

  // POST /test-connection — verify reachability + list available models for a cloud provider
  // Body: { provider, apiKey?, baseUrl?, configName? }
  // If apiKey is missing or redacted, falls back to the stored key for configName (or provider).
  fastify.post<{ Body: { provider?: string; apiKey?: string; baseUrl?: string; configName?: string } }>(
    '/test-connection',
    async (request, reply) => {
      const body = request.body || {};
      const provider = (body.provider || '').toLowerCase();
      if (!provider) return reply.status(400).send({ ok: false, error: 'provider is required' });

      const lookupName = body.configName || provider;
      const cfg = getModelsConfig();
      const storedEntry = cfg?.llm[lookupName];
      const storedObj = (storedEntry && typeof storedEntry !== 'string') ? storedEntry : null;

      let apiKey = body.apiKey?.trim() || '';
      if (!apiKey || apiKey.startsWith('••••')) {
        if (storedObj?.apiKey) {
          const resolved = resolveApiKey(provider as any, storedObj.apiKey);
          if (resolved) apiKey = resolved;
        }
      }
      if (!apiKey) {
        // For some providers an env var may still be set even without configName
        const envVar = PROVIDER_ENV_VARS[provider];
        if (envVar && process.env[envVar]) apiKey = process.env[envVar]!;
      }

      // baseUrl: explicit body value wins; otherwise fall back to stored config's baseUrl
      let baseUrl: string;
      if (body.baseUrl !== undefined) {
        baseUrl = body.baseUrl.trim().replace(/\/+$/, '');
      } else {
        baseUrl = (storedObj?.baseUrl || '').replace(/\/+$/, '');
      }
      const start = Date.now();

      try {
        const result = await listProviderModels(provider, apiKey, baseUrl);
        return {
          ok: true,
          models: result.models,
          latencyMs: Date.now() - start,
          ...(result.warning ? { warning: result.warning } : {}),
        };
      } catch (err: any) {
        logger.warn(`test-connection failed for ${provider}: ${err?.message || err}`);
        return reply.status(200).send({
          ok: false,
          error: err?.message || String(err),
          latencyMs: Date.now() - start,
        });
      }
    },
  );

  // GET /readiness — check if default model + embedding are usable
  fastify.get('/readiness', async () => {
    const issues: string[] = [];
    const config = getModelsConfig();

    // Check if default exists (either as a concrete entry or as a pointer to one)
    const hasDefaultModel = config?.llm['default'] !== undefined;
    if (hasDefaultModel) {
      try {
        const result = await checkConfigReady(getModelConfig('default'), manager);
        if (!result.ready) issues.push(`Chat: ${result.reason}`);
      } catch {
        issues.push('Default model pointer is broken');
      }
    } else {
      issues.push('No default model configured');
    }

    const hasDefaultEmb = config?.embeddings['default'] !== undefined;
    if (hasDefaultEmb) {
      try {
        const result = await checkConfigReady(getEmbeddingConfig('default'), manager);
        if (!result.ready) issues.push(`Embedding: ${result.reason}`);
      } catch {
        issues.push('Default embedding pointer is broken');
      }
    } else {
      issues.push('No default embedding configured');
    }

    return { ready: issues.length === 0, issues };
  });

  // List all available LLM configs (only active ones)
  fastify.get('/', async () => {
    const names = listModelConfigs();
    const fullConfig = getModelsConfig();
    return names
      .filter((name) => {
        const entry = fullConfig?.llm[name];
        if (!entry || typeof entry === 'string') return true;
        return entry.active !== false;
      })
      .map((name) => {
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

      // Send task ID as first event so the client can cancel via the tasks API
      reply.raw.write(`data: ${JSON.stringify({ type: 'task_id', taskId: task.id })}\n\n`);

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
            reply.raw.write(`data: ${JSON.stringify({ type: 'content', content })}\n\n`);
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
