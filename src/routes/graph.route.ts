import type { FastifyPluginAsync } from 'fastify';
import { GraphRagFactory } from '../../lib/knowledge/graph-rag/graph-rag-factory.ts';
import type { GraphNode, GraphEdge, GraphStore } from '../../lib/knowledge/graph-rag/types.ts';

/**
 * Get all registered graph stores.
 */
function getAllGraphStores(): Map<string, GraphStore> {
  return (GraphRagFactory as any).graphStores as Map<string, GraphStore> ?? new Map();
}

function formatResponse(nodes: GraphNode[], edges: GraphEdge[]) {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type,
      name: n.name,
      description: n.description,
      properties: n.properties,
    })),
    edges: edges
      .filter((e) => e.type !== 'BELONGS_TO_KB')
      .map((e) => ({
        id: e.id,
        type: e.type,
        source: e.sourceId,
        target: e.targetId,
        description: e.description,
        weight: e.weight,
      })),
  };
}

export const graphRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/config', async () => {
    const stores = getAllGraphStores();
    return { configured: stores.size > 0 };
  });

  // Aggregate KnowledgeBase nodes from ALL graph stores
  fastify.get('/knowledge-bases', async (_request, reply) => {
    try {
      const stores = getAllGraphStores();
      if (stores.size === 0) {
        return reply.status(404).send({ error: 'No graph stores available.' });
      }

      const kbNodes: GraphNode[] = [];
      for (const store of stores.values()) {
        const nodes = await store.getAllNodes();
        kbNodes.push(...nodes.filter((n) => n.type === 'KnowledgeBase'));
      }

      return formatResponse(kbNodes, []);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fastify.log.error(`Graph KB query error: ${message}`);
      return reply.status(500).send({ error: message });
    }
  });

  // Aggregate nodes + edges from ALL graph stores
  fastify.get<{ Querystring: { limit?: string } }>('/full', async (request, reply) => {
    try {
      const stores = getAllGraphStores();
      if (stores.size === 0) {
        return reply.status(404).send({ error: 'No graph stores available.' });
      }

      const limit = Math.min(parseInt(request.query.limit ?? '300', 10), 1000);
      const allNodes: GraphNode[] = [];
      const allEdges: GraphEdge[] = [];

      for (const store of stores.values()) {
        allNodes.push(...await store.getAllNodes());
        allEdges.push(...await store.getAllEdges());
      }

      const limitedNodes = allNodes.slice(0, limit);
      const nodeIds = new Set(limitedNodes.map((n) => n.id));
      const limitedEdges = allEdges.filter(
        (e) => nodeIds.has(e.sourceId) && nodeIds.has(e.targetId)
      );

      return formatResponse(limitedNodes, limitedEdges);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fastify.log.error(`Graph full query error: ${message}`);
      return reply.status(500).send({ error: message });
    }
  });

  // Search across ALL stores for the node, then get its neighbors
  fastify.get<{ Params: { nodeId: string }; Querystring: { depth?: string } }>(
    '/neighbors/:nodeId',
    async (request, reply) => {
      try {
        const stores = getAllGraphStores();
        if (stores.size === 0) {
          return reply.status(404).send({ error: 'No graph stores available.' });
        }

        const nodeId = decodeURIComponent(request.params.nodeId);
        const depth = Math.min(parseInt(request.query.depth ?? '1', 10), 3);

        // Find which store has this node
        for (const store of stores.values()) {
          const node = await store.getNode(nodeId);
          if (node) {
            const { nodes, edges } = await store.getNeighbors(nodeId, depth);
            return formatResponse(nodes, edges);
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
