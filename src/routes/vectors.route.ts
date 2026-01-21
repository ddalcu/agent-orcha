import type { FastifyPluginAsync } from 'fastify';

interface VectorParams {
  name: string;
}

interface SearchBody {
  query: string;
  k?: number;
}

interface AddDocumentsBody {
  documents: Array<{
    content: string;
    metadata?: Record<string, unknown>;
  }>;
}

export const vectorsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async () => {
    const configs = fastify.orchestrator.vectors.listConfigs();
    return configs.map((config) => ({
      name: config.name,
      description: config.description,
      source: config.source,
      store: config.store.type,
    }));
  });

  fastify.get<{ Params: VectorParams }>('/:name', async (request, reply) => {
    const config = fastify.orchestrator.vectors.getConfig(request.params.name);

    if (!config) {
      return reply.status(404).send({
        error: 'Vector store not found',
        name: request.params.name,
      });
    }

    return config;
  });

  fastify.post<{ Params: VectorParams; Body: SearchBody }>(
    '/:name/search',
    async (request, reply) => {
      const { name } = request.params;
      const { query, k } = request.body;

      try {
        const results = await fastify.orchestrator.searchVectors(name, query, k);
        return { results };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (message.includes('not found')) {
          return reply.status(404).send({ error: message });
        }

        return reply.status(500).send({ error: message });
      }
    }
  );

  fastify.post<{ Params: VectorParams }>(
    '/:name/refresh',
    async (request, reply) => {
      const { name } = request.params;

      try {
        await fastify.orchestrator.vectors.refresh(name);
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.status(500).send({ error: message });
      }
    }
  );

  fastify.post<{ Params: VectorParams; Body: AddDocumentsBody }>(
    '/:name/add',
    async (request, reply) => {
      const { name } = request.params;
      const { documents } = request.body;

      try {
        const store = fastify.orchestrator.vectors.get(name);

        if (!store) {
          await fastify.orchestrator.vectors.initialize(name);
          const initializedStore = fastify.orchestrator.vectors.get(name);

          if (!initializedStore) {
            return reply.status(404).send({
              error: 'Vector store not found',
              name,
            });
          }

          await initializedStore.addDocuments(documents);
        } else {
          await store.addDocuments(documents);
        }

        return { success: true, added: documents.length };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.status(500).send({ error: message });
      }
    }
  );
};
