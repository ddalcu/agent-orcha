import type { FastifyPluginAsync } from 'fastify';
import { LLMFactory, listModelConfigs, getModelConfig } from '../../lib/llm/index.ts';
import { humanMessage, aiMessage } from '../../lib/types/llm-types.ts';
import type { MessageContent, ContentPart } from '../../lib/types/llm-types.ts';
import { logger } from '../../lib/logger.ts';

interface LLMParams {
  name: string;
}

interface Attachment {
  data: string;
  mediaType: string;
}

interface ChatBody {
  message: string;
  sessionId?: string;
  attachments?: Attachment[];
}

function buildUserContent(text: string, attachments?: Attachment[]): MessageContent {
  if (!Array.isArray(attachments) || attachments.length === 0) return text;

  const parts: ContentPart[] = [];
  if (text) parts.push({ type: 'text', text });
  for (const att of attachments) {
    if (att && typeof att.data === 'string' && typeof att.mediaType === 'string') {
      parts.push({ type: 'image', data: att.data, mediaType: att.mediaType });
    }
  }
  return parts.length > 0 ? parts : text;
}

export const llmRoutes: FastifyPluginAsync = async (fastify) => {
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
        const userContent = buildUserContent(message, attachments);
        const messages = [...history, humanMessage(userContent)];

        const llm = LLMFactory.create(name);
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
        const userContent = buildUserContent(message, attachments);
        const messages = [...history, humanMessage(userContent)];

        // Store text-only user message (no base64 in memory)
        if (sessionId) store.addMessage(sessionId, humanMessage(message));

        const llm = LLMFactory.create(name);
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
