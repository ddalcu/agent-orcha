import type { FastifyPluginAsync } from 'fastify';
import { LLMFactory, listModelConfigs, getModelConfig } from '../../lib/llm/index.js';
import { HumanMessage } from '@langchain/core/messages';
import { logger } from '../../lib/logger.js';

interface LLMParams {
  name: string;
}

interface ChatBody {
  message: string;
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
      const { message } = request.body;

      if (!message || typeof message !== 'string') {
        return reply.status(400).send({ error: 'message is required' });
      }

      const taskManager = fastify.orchestrator.tasks.getManager();
      const task = taskManager.track('llm', name, { message });

      try {
        const llm = LLMFactory.create(name);
        const response = await llm.invoke([new HumanMessage(message)]);

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
      const { message } = request.body;

      if (!message || typeof message !== 'string') {
        return reply.status(400).send({ error: 'message is required' });
      }

      const taskManager = fastify.orchestrator.tasks.getManager();
      const task = taskManager.track('llm', name, { message });

      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');

      try {
        const llm = LLMFactory.create(name);
        const stream = await llm.stream([new HumanMessage(message)]);

        let lastChunk: any = null;
        for await (const chunk of stream) {
          lastChunk = chunk;
          const content = chunk.content;
          if (content) {
            reply.raw.write(`data: ${JSON.stringify({ content })}\n\n`);
          }
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
        reply.raw.end();
      } catch (error) {
        logger.error('[LLM Route] Error streaming LLM:', error);
        const message = error instanceof Error ? error.message : String(error);
        fastify.log.error({ error }, 'LLM streaming error');
        taskManager.reject(task.id, error);
        reply.raw.write(`data: ${JSON.stringify({ error: message })}\n\n`);
        reply.raw.end();
      }
    }
  );
};
