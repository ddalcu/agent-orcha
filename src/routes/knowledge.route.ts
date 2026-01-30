import type { FastifyPluginAsync } from 'fastify';
import { GraphRagFactory } from '../../lib/knowledge/graph-rag/graph-rag-factory.js';

interface KnowledgeParams {
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

export const knowledgeRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async () => {
    const configs = fastify.orchestrator.knowledge.listConfigs();
    return configs.map((config) => ({
      name: config.name,
      kind: config.kind,
      description: config.description,
      source: config.source,
      store: config.kind === 'vector' ? (config as any).store?.type : config.kind,
    }));
  });

  fastify.get<{ Params: KnowledgeParams }>('/:name', async (request, reply) => {
    const config = fastify.orchestrator.knowledge.getConfig(request.params.name);

    if (!config) {
      return reply.status(404).send({
        error: 'Knowledge store not found',
        name: request.params.name,
      });
    }

    return config;
  });

  fastify.post<{ Params: KnowledgeParams; Body: SearchBody }>(
    '/:name/search',
    async (request, reply) => {
      const { name } = request.params;
      const { query, k } = request.body;

      try {
        const results = await fastify.orchestrator.searchKnowledge(name, query, k);
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

  fastify.post<{ Params: KnowledgeParams }>(
    '/:name/refresh',
    async (request, reply) => {
      const { name } = request.params;

      try {
        await fastify.orchestrator.knowledge.refresh(name);
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.status(500).send({ error: message });
      }
    }
  );

  fastify.post<{ Params: KnowledgeParams; Body: AddDocumentsBody }>(
    '/:name/add',
    async (request, reply) => {
      const { name } = request.params;
      const { documents } = request.body;

      try {
        const store = fastify.orchestrator.knowledge.get(name);

        if (!store) {
          await fastify.orchestrator.knowledge.initialize(name);
          const initializedStore = fastify.orchestrator.knowledge.get(name);

          if (!initializedStore) {
            return reply.status(404).send({
              error: 'Knowledge store not found',
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

  // --- Graph-RAG specific endpoints ---

  fastify.get<{ Params: KnowledgeParams }>(
    '/:name/entities',
    async (request, reply) => {
      const { name } = request.params;
      const config = fastify.orchestrator.knowledge.getConfig(name);

      if (!config) {
        return reply.status(404).send({ error: 'Knowledge store not found', name });
      }

      if (config.kind !== 'graph-rag') {
        return reply.status(400).send({ error: `"${name}" is not a graph-rag knowledge store` });
      }

      const graphStore = GraphRagFactory.getGraphStore(name);
      if (!graphStore) {
        return reply.status(404).send({ error: `Graph store not initialized for "${name}"` });
      }

      const nodes = await graphStore.getAllNodes();
      return {
        count: nodes.length,
        entities: nodes.map((n) => ({
          id: n.id,
          type: n.type,
          name: n.name,
          description: n.description,
          sourceChunkIds: n.sourceChunkIds,
        })),
      };
    }
  );

  fastify.get<{ Params: KnowledgeParams }>(
    '/:name/communities',
    async (request, reply) => {
      const { name } = request.params;
      const config = fastify.orchestrator.knowledge.getConfig(name);

      if (!config) {
        return reply.status(404).send({ error: 'Knowledge store not found', name });
      }

      if (config.kind !== 'graph-rag') {
        return reply.status(400).send({ error: `"${name}" is not a graph-rag knowledge store` });
      }

      const graphStore = GraphRagFactory.getGraphStore(name);
      if (!graphStore) {
        return reply.status(404).send({ error: `Graph store not initialized for "${name}"` });
      }

      const communities = await graphStore.getCommunities();
      return {
        count: communities.length,
        communities: communities.map((c) => ({
          id: c.id,
          title: c.title,
          summary: c.summary,
          nodeCount: c.nodeIds.length,
          nodeIds: c.nodeIds,
        })),
      };
    }
  );

  fastify.get<{ Params: KnowledgeParams }>(
    '/:name/edges',
    async (request, reply) => {
      const { name } = request.params;
      const config = fastify.orchestrator.knowledge.getConfig(name);

      if (!config) {
        return reply.status(404).send({ error: 'Knowledge store not found', name });
      }

      if (config.kind !== 'graph-rag') {
        return reply.status(400).send({ error: `"${name}" is not a graph-rag knowledge store` });
      }

      const graphStore = GraphRagFactory.getGraphStore(name);
      if (!graphStore) {
        return reply.status(404).send({ error: `Graph store not initialized for "${name}"` });
      }

      const edges = await graphStore.getAllEdges();
      return {
        count: edges.length,
        edges: edges.map((e) => ({
          id: e.id,
          type: e.type,
          sourceId: e.sourceId,
          targetId: e.targetId,
          description: e.description,
          weight: e.weight,
        })),
      };
    }
  );
};
