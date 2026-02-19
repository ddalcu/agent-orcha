import type { FastifyPluginAsync } from 'fastify';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { logger } from '../../lib/logger.ts';

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

      // Get the tool's schema and convert Zod to JSON Schema
      const tool = func.tool;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const jsonSchema = zodToJsonSchema(tool.schema as any, {
        name: func.name,
        $refStrategy: 'none',
      });

      // Extract the actual schema from $ref if present
      let finalSchema = jsonSchema;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((jsonSchema as any).$ref && (jsonSchema as any).definitions) {
        // Extract the schema name from $ref (e.g., "#/definitions/calculator" -> "calculator")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const refName = (jsonSchema as any).$ref.split('/').pop();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (refName && (jsonSchema as any).definitions[refName]) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          finalSchema = (jsonSchema as any).definitions[refName];
        }
      }

      return {
        name: func.name,
        description: func.metadata.description,
        version: func.metadata.version || null,
        author: func.metadata.author || null,
        tags: func.metadata.tags || [],
        schema: finalSchema,
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
