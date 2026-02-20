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
  return configs
    .filter((config: any) => {
      const store = orchestrator.knowledge.getSqliteStore(config.name);
      return store && store.getEntityCount() > 0;
    })
    .map((config: any) => {
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

      const rootEntities: EntityRow[] = [];
      const containsEdges: { id: string; type: string; source: string; target: string; description: string; weight: number }[] = [];

      for (const [name, store] of stores) {
        const entities = store.getAllEntities();
        const relationships = store.getAllRelationships();

        // Root entities = those not a source of any relationship (tree graphs)
        // Fallback to all entities for mesh/web graphs where every node is a source
        const childIds = new Set(relationships.map((r) => r.source_id));
        const roots = entities.filter((e) => !childIds.has(e.id));
        const topLevel = roots.length > 0 ? roots : entities;

        for (const entity of topLevel) {
          rootEntities.push(entity);
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

      const formatted = formatResponse(rootEntities, []);
      return {
        nodes: [...kbNodes, ...formatted.nodes],
        edges: containsEdges,
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

        // Expanding a KnowledgeBase node → return only root entities (depth=1)
        if (nodeId.startsWith('kb::')) {
          const storeName = nodeId.slice(4);
          const store = fastify.orchestrator.knowledge.getSqliteStore(storeName);
          if (!store) return { nodes: [], edges: [] };

          const allEntities = store.getAllEntities();
          const allRelationships = store.getAllRelationships();

          // Root entities = those not a source of any relationship (tree graphs)
          // Fallback to all entities for mesh/web graphs where every node is a source
          const childIds = new Set(allRelationships.map((r) => r.source_id));
          const roots = allEntities.filter((e: EntityRow) => !childIds.has(e.id));
          const rootEntities = roots.length > 0 ? roots : allEntities;

          const containsEdges = rootEntities.map((e: EntityRow) => ({
            id: `kb-contains::${storeName}::${e.id}`,
            type: 'CONTAINS',
            source: nodeId,
            target: e.id,
            description: '',
            weight: 1,
          }));

          return {
            nodes: formatResponse(rootEntities, []).nodes,
            edges: containsEdges,
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
