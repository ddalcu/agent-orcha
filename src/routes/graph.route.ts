import type { FastifyPluginAsync } from 'fastify';
import type { SqliteStore, EntityRow, RelationshipRow } from '../../lib/knowledge/sqlite-store.ts';

function formatResponse(entities: EntityRow[], relationships: RelationshipRow[]) {
  return {
    nodes: entities.map((e) => ({
      id: e.id,
      type: e.type,
      name: e.name,
      description: e.description,
      properties: JSON.parse(e.properties),
    })),
    edges: relationships.map((r) => ({
      id: r.id,
      type: r.type,
      source: r.source_id,
      target: r.target_id,
      description: r.description,
      weight: r.weight,
    })),
  };
}

/**
 * Build KnowledgeBase-type nodes for all configs.
 */
function buildKbNodes(orchestrator: any) {
  const configs = orchestrator.knowledge.listConfigs();
  return configs.map((config: any) => {
    const sqliteStore = orchestrator.knowledge.getSqliteStore(config.name);
    return {
      id: `kb::${config.name}`,
      type: 'KnowledgeBase',
      name: config.name,
      description: config.description || config.name,
      properties: {
        sourceType: config.source?.type ?? 'unknown',
        hasGraph: !!config.graph,
        chunkCount: sqliteStore?.getChunkCount() ?? 0,
        entityCount: sqliteStore?.getEntityCount() ?? 0,
        edgeCount: sqliteStore?.getRelationshipCount() ?? 0,
      },
    };
  });
}

/**
 * Get all SqliteStores that have entities (graph data).
 */
function getEntityStores(orchestrator: any): Map<string, SqliteStore> {
  const stores = new Map<string, SqliteStore>();
  const configs = orchestrator.knowledge.listConfigs();

  for (const config of configs) {
    const sqliteStore = orchestrator.knowledge.getSqliteStore(config.name);
    if (sqliteStore && sqliteStore.getEntityCount() > 0) {
      stores.set(config.name, sqliteStore);
    }
  }

  return stores;
}

export const graphRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/config', async () => {
    const configs = fastify.orchestrator.knowledge.listConfigs();
    return { configured: configs.length > 0 };
  });

  fastify.get('/knowledge-bases', async () => {
    return { nodes: buildKbNodes(fastify.orchestrator), edges: [] };
  });

  // Aggregate nodes + edges from ALL stores, including KB parent nodes
  fastify.get<{ Querystring: { limit?: string } }>('/full', async (request, reply) => {
    try {
      const kbNodes = buildKbNodes(fastify.orchestrator);
      const stores = getEntityStores(fastify.orchestrator);

      if (kbNodes.length === 0) {
        return reply.status(404).send({ error: 'No graph stores available.' });
      }

      const limit = Math.min(parseInt(request.query.limit ?? '300', 10), 1000);
      const allEntities: EntityRow[] = [];
      const allRelationships: RelationshipRow[] = [];
      const containsEdges: { id: string; type: string; source: string; target: string; description: string; weight: number }[] = [];

      for (const [name, store] of stores) {
        const entities = store.getAllEntities();
        allEntities.push(...entities);
        allRelationships.push(...store.getAllRelationships());

        for (const entity of entities) {
          containsEdges.push({
            id: `kb-contains::${name}::${entity.id}`,
            type: 'CONTAINS',
            source: `kb::${name}`,
            target: entity.id,
            description: '',
            weight: 1,
          });
        }
      }

      const limitedEntities = allEntities.slice(0, limit);
      const entityIds = new Set(limitedEntities.map((e) => e.id));
      const limitedRelationships = allRelationships.filter(
        (r) => entityIds.has(r.source_id) && entityIds.has(r.target_id)
      );
      const limitedContainsEdges = containsEdges.filter((e) => entityIds.has(e.target));

      const formatted = formatResponse(limitedEntities, limitedRelationships);
      return {
        nodes: [...kbNodes, ...formatted.nodes],
        edges: [...limitedContainsEdges, ...formatted.edges],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fastify.log.error(`Graph full query error: ${message}`);
      return reply.status(500).send({ error: message });
    }
  });

  // Expand a node — handles both KB nodes (kb::name) and regular entity nodes
  fastify.get<{ Params: { nodeId: string }; Querystring: { depth?: string } }>(
    '/neighbors/:nodeId',
    async (request, reply) => {
      try {
        const nodeId = decodeURIComponent(request.params.nodeId);

        // Expanding a KnowledgeBase node → return its entities + CONTAINS edges
        if (nodeId.startsWith('kb::')) {
          const storeName = nodeId.slice(4);
          const store = fastify.orchestrator.knowledge.getSqliteStore(storeName);
          if (!store) return { nodes: [], edges: [] };

          const entities = store.getAllEntities();
          const formatted = formatResponse(entities, store.getAllRelationships());
          const containsEdges = entities.map((e: EntityRow) => ({
            id: `kb-contains::${storeName}::${e.id}`,
            type: 'CONTAINS',
            source: nodeId,
            target: e.id,
            description: '',
            weight: 1,
          }));

          return {
            nodes: formatted.nodes,
            edges: [...containsEdges, ...formatted.edges],
          };
        }

        // Regular entity node — search across all stores
        const stores = getEntityStores(fastify.orchestrator);
        if (stores.size === 0) {
          return reply.status(404).send({ error: 'No graph stores available.' });
        }

        const depth = Math.min(parseInt(request.query.depth ?? '1', 10), 3);

        for (const store of stores.values()) {
          const entity = store.getEntity(nodeId);
          if (entity) {
            const { entities, relationships } = store.getNeighborhood(nodeId, depth);
            return formatResponse(entities, relationships);
          }
        }

        return formatResponse([], []);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fastify.log.error(`Graph neighbors query error: ${message}`);
        return reply.status(500).send({ error: message });
      }
    }
  );
};
