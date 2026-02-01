import type { FastifyPluginAsync } from 'fastify';
import { GraphRagFactory } from '../../lib/knowledge/graph-rag/graph-rag-factory.js';
import type { IndexingProgressCallback } from '../../lib/knowledge/knowledge-store-metadata.js';

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

// Track active SSE connections for indexing progress
const sseConnections = new Map<string, Set<(event: string, data: string) => void>>();
// Track last progress event per store so reconnecting clients get current state
const lastProgressEvents = new Map<string, { event: string; data: string }>();

function addSSEListener(name: string, listener: (event: string, data: string) => void) {
  if (!sseConnections.has(name)) {
    sseConnections.set(name, new Set());
  }
  sseConnections.get(name)!.add(listener);
}

function removeSSEListener(name: string, listener: (event: string, data: string) => void) {
  sseConnections.get(name)?.delete(listener);
  if (sseConnections.get(name)?.size === 0) {
    sseConnections.delete(name);
  }
}

function broadcastSSE(name: string, event: string, data: string) {
  // Store latest progress so reconnecting clients can catch up
  lastProgressEvents.set(name, { event, data });

  // Clear stored progress on terminal events after a short delay,
  // giving late-connecting SSE clients time to receive them
  const parsed = JSON.parse(data);
  if (parsed.phase === 'done' || parsed.phase === 'error') {
    setTimeout(() => lastProgressEvents.delete(name), 5000);
  }

  const listeners = sseConnections.get(name);
  if (listeners) {
    for (const listener of listeners) {
      listener(event, data);
    }
  }
}

export const knowledgeRoutes: FastifyPluginAsync = async (fastify) => {
  // GET / - List all knowledge stores with status metadata
  fastify.get('/', async () => {
    const configs = fastify.orchestrator.knowledge.listConfigs();
    const statuses = await fastify.orchestrator.knowledge.getAllStatuses();

    return configs.map((config) => {
      const status = statuses.get(config.name);
      const isGraphRag = config.kind === 'graph-rag';
      const graphConfig = isGraphRag ? (config as any).graph : null;
      return {
        name: config.name,
        kind: config.kind,
        description: config.description,
        source: config.source,
        store: isGraphRag ? (graphConfig?.store?.type ?? 'memory') : ((config as any).store?.type ?? 'memory'),
        extractionMode: isGraphRag ? (graphConfig?.extractionMode ?? 'llm') : null,
        defaultK: isGraphRag
          ? ((config as any).search?.defaultK ?? 10)
          : ((config as any).search?.defaultK ?? 4),
        status: status?.status ?? 'not_indexed',
        lastIndexedAt: status?.lastIndexedAt ?? null,
        lastIndexDurationMs: status?.lastIndexDurationMs ?? null,
        documentCount: status?.documentCount ?? 0,
        chunkCount: status?.chunkCount ?? 0,
        entityCount: status?.entityCount ?? 0,
        edgeCount: status?.edgeCount ?? 0,
        communityCount: status?.communityCount ?? 0,
        embeddingModel: status?.embeddingModel ?? config.embedding,
        errorMessage: status?.errorMessage ?? null,
        isIndexing: fastify.orchestrator.knowledge.isIndexing(config.name),
      };
    });
  });

  // GET /:name - Get config for a specific store
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

  // GET /:name/status - Get metadata/status for a specific store
  fastify.get<{ Params: KnowledgeParams }>(
    '/:name/status',
    async (request, reply) => {
      const { name } = request.params;
      const config = fastify.orchestrator.knowledge.getConfig(name);

      if (!config) {
        return reply.status(404).send({ error: 'Knowledge store not found', name });
      }

      const statusData = await fastify.orchestrator.knowledge.getStatus(name);
      return {
        name,
        kind: config.kind,
        isIndexing: fastify.orchestrator.knowledge.isIndexing(name),
        status: statusData?.status ?? 'not_indexed',
        lastIndexedAt: statusData?.lastIndexedAt ?? null,
        lastIndexDurationMs: statusData?.lastIndexDurationMs ?? null,
        documentCount: statusData?.documentCount ?? 0,
        chunkCount: statusData?.chunkCount ?? 0,
        entityCount: statusData?.entityCount ?? 0,
        edgeCount: statusData?.edgeCount ?? 0,
        communityCount: statusData?.communityCount ?? 0,
        embeddingModel: statusData?.embeddingModel ?? config.embedding,
        errorMessage: statusData?.errorMessage ?? null,
      };
    }
  );

  // POST /:name/index - Trigger async indexing
  fastify.post<{ Params: KnowledgeParams }>(
    '/:name/index',
    async (request, reply) => {
      const { name } = request.params;
      const config = fastify.orchestrator.knowledge.getConfig(name);

      if (!config) {
        return reply.status(404).send({ error: 'Knowledge store not found', name });
      }

      if (fastify.orchestrator.knowledge.isIndexing(name)) {
        return reply.status(409).send({ error: `"${name}" is already being indexed` });
      }

      // Create progress callback that broadcasts to SSE listeners
      const onProgress: IndexingProgressCallback = (event) => {
        broadcastSSE(name, 'progress', JSON.stringify(event));
      };

      // Check if store is already initialized (re-index vs first index)
      const existingStore = fastify.orchestrator.knowledge.get(name);

      // Start indexing in background
      if (existingStore) {
        fastify.orchestrator.knowledge.refresh(name, onProgress).catch((error) => {
          broadcastSSE(name, 'error', JSON.stringify({
            name,
            phase: 'error',
            progress: 0,
            message: error instanceof Error ? error.message : String(error),
          }));
        });
      } else {
        fastify.orchestrator.knowledge.initialize(name, onProgress).catch((error) => {
          broadcastSSE(name, 'error', JSON.stringify({
            name,
            phase: 'error',
            progress: 0,
            message: error instanceof Error ? error.message : String(error),
          }));
        });
      }

      return { success: true, message: `Indexing started for "${name}"` };
    }
  );

  // GET /:name/index/stream - SSE endpoint for indexing progress
  fastify.get<{ Params: KnowledgeParams }>(
    '/:name/index/stream',
    async (request, reply) => {
      const { name } = request.params;

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      const listener = (event: string, data: string) => {
        reply.raw.write(`event: ${event}\ndata: ${data}\n\n`);

        // Close connection on terminal events
        const parsed = JSON.parse(data);
        if (parsed.phase === 'done' || parsed.phase === 'error') {
          setTimeout(() => {
            removeSSEListener(name, listener);
            reply.raw.end();
          }, 100);
        }
      };

      addSSEListener(name, listener);

      // Send initial heartbeat
      reply.raw.write(`event: connected\ndata: {"name":"${name}"}\n\n`);

      // Send last known progress so reconnecting clients catch up
      const lastProgress = lastProgressEvents.get(name);
      if (lastProgress) {
        reply.raw.write(`event: ${lastProgress.event}\ndata: ${lastProgress.data}\n\n`);
      }

      // Clean up on client disconnect
      request.raw.on('close', () => {
        removeSSEListener(name, listener);
      });
    }
  );

  // POST /:name/search
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

  // POST /:name/refresh
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

  // POST /:name/add
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
