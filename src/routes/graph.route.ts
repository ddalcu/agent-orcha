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

      if (kbNodes.length === 0) {
        return reply.status(404).send({ error: 'No graph stores available.' });
      }

      const limit = request.query.limit ? parseInt(request.query.limit, 10) : undefined;
      const stores = getEntityStores(fastify.orchestrator);

      const allEntityNodes: EntityRow[] = [];
      const allEdges: { id: string; type: string; source: string; target: string; description: string; weight: number }[] = [];

      for (const [name, store] of stores) {
        let entities = store.getAllEntities();
        const relationships = store.getAllRelationships();

        if (limit !== undefined) {
          entities = entities.slice(0, limit);
        }

        for (const entity of entities) {
          allEntityNodes.push(entity);
          allEdges.push({
            id: `kb-contains::${name}::${entity.id}`,
            type: 'CONTAINS',
            source: `kb::${name}`,
            target: entity.id,
            description: '',
            weight: 1,
          });
        }

        const entityIds = new Set(entities.map((e) => e.id));
        for (const rel of relationships) {
          if (entityIds.has(rel.source_id) && entityIds.has(rel.target_id)) {
            allEdges.push({
              id: rel.id,
              type: rel.type,
              source: rel.source_id,
              target: rel.target_id,
              description: rel.description,
              weight: rel.weight,
            });
          }
        }
      }

      const formatted = formatResponse(allEntityNodes, []);
      return {
        nodes: [...kbNodes, ...formatted.nodes],
        edges: allEdges,
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

        // Expanding a KnowledgeBase node → return all entities with CONTAINS + relationship edges
        if (nodeId.startsWith('kb::')) {
          const storeName = nodeId.slice(4);
          const store = fastify.orchestrator.knowledge.getSqliteStore(storeName);
          if (!store) return { nodes: [], edges: [] };

          const entities = store.getAllEntities();
          const relationships = store.getAllRelationships();

          const containsEdges = entities.map((e: EntityRow) => ({
            id: `kb-contains::${storeName}::${e.id}`,
            type: 'CONTAINS',
            source: nodeId,
            target: e.id,
            description: '',
            weight: 1,
          }));

          const relEdges = relationships.map((r) => ({
            id: r.id,
            type: r.type,
            source: r.source_id,
            target: r.target_id,
            description: r.description,
            weight: r.weight,
          }));

          return {
            nodes: formatResponse(entities, []).nodes,
            edges: [...containsEdges, ...relEdges],
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
