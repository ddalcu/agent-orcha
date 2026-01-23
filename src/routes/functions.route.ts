import type { FastifyPluginAsync } from 'fastify';
import { logger } from '../../lib/logger.js';

interface FunctionParams {
  name: string;
}

interface CallFunctionBody {
  arguments: Record<string, unknown>;
}

export const functionsRoutes: FastifyPluginAsync = async (fastify) => {
  // List all available functions
  fastify.get('/', async () => {
    const functions = fastify.orchestrator.functions.list();

    return functions.map((func) => ({
      name: func.name,
      description: func.metadata.description,
      version: func.metadata.version || null,
      author: func.metadata.author || null,
      tags: func.metadata.tags || [],
    }));
  });

  // Get a specific function
  fastify.get<{ Params: FunctionParams }>('/:name', async (request, reply) => {
    try {
      const func = fastify.orchestrator.functions.get(request.params.name);

      if (!func) {
        return reply.status(404).send({ error: `Function "${request.params.name}" not found` });
      }

      // Get the tool's schema
      const tool = func.tool;

      return {
        name: func.name,
        description: func.metadata.description,
        version: func.metadata.version || null,
        author: func.metadata.author || null,
        tags: func.metadata.tags || [],
        schema: tool.schema,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(404).send({ error: message });
    }
  });

  // Call a function
  fastify.post<{ Params: FunctionParams; Body: CallFunctionBody }>(
    '/:name/call',
    async (request, reply) => {
      const { name } = request.params;
      const { arguments: args } = request.body;

      if (!args || typeof args !== 'object') {
        return reply.status(400).send({ error: 'arguments object is required' });
      }

      try {
        const tool = fastify.orchestrator.functions.getTool(name);

        if (!tool) {
          return reply.status(404).send({ error: `Function "${name}" not found` });
        }

        const result = await tool.invoke(args);

        return {
          content: result,
          function: name,
        };
      } catch (error) {
        logger.error('[Functions Route] Error calling function:', error);
        const message = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        fastify.log.error({ error, stack }, 'Function call error');
        return reply.status(500).send({ error: message });
      }
    }
  );
};
