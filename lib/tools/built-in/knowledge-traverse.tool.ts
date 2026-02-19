import { tool } from '../../types/tool-factory.ts';
import { z } from 'zod';
import type { StructuredTool } from '../../types/llm-types.ts';
import type { GraphStore, GraphNode, GraphEdge } from '../../knowledge/graph-rag/types.ts';
import type { KnowledgeConfig, GraphRagKnowledgeConfig } from '../../knowledge/types.ts';
import { buildGraphSchemaDescription } from './knowledge-tools-factory.ts';

const MAX_NODES = 50;

/**
 * Create a graph traversal tool for a graph-rag knowledge base.
 * Gets the neighborhood around an entity (N hops).
 */
export function createKnowledgeTraverseTool(
  name: string,
  config: KnowledgeConfig,
  graphStore: GraphStore
): StructuredTool {
  const schemaInfo = buildGraphSchemaDescription(config as GraphRagKnowledgeConfig);

  return tool(
    async ({ entityName, entityId, depth }) => {
      const effectiveDepth = Math.min(Math.max(depth ?? 1, 1), 3);
      let targetId = entityId;

      // If name given but no ID, search for a matching node
      if (!targetId && entityName) {
        try {
          const allNodes = await graphStore.getAllNodes();
          const nameLower = entityName.toLowerCase();
          const match = allNodes.find(
            (n) => n.name.toLowerCase() === nameLower || n.name.toLowerCase().includes(nameLower)
          );
          if (!match) {
            return `No entity found matching name "${entityName}". Try a different name or use knowledge_entity_lookup_${name} to search.`;
          }
          targetId = match.id;
        } catch (error) {
          return `Error searching for entity: ${error instanceof Error ? error.message : String(error)}`;
        }
      }

      if (!targetId) {
        return 'Provide either entityName or entityId to traverse from.';
      }

      try {
        const { nodes, edges } = await graphStore.getNeighbors(targetId, effectiveDepth);

        if (nodes.length === 0) {
          return `No neighbors found for entity "${targetId}" at depth ${effectiveDepth}.`;
        }

        const truncated = nodes.length > MAX_NODES;
        const displayNodes = nodes.slice(0, MAX_NODES);

        return formatTraversalResult(displayNodes, edges, effectiveDepth, truncated, nodes.length);
      } catch (error) {
        return `Traversal error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    {
      name: `knowledge_traverse_${name}`,
      description: `Explore the neighborhood around an entity in the "${name}" knowledge graph. Returns connected nodes and relationships within N hops.

${schemaInfo}

TIPS: Use this to understand how an entity relates to others. Start with depth=1 for immediate connections. Use knowledge_entity_lookup_${name} first if you need to find the entity's ID or name.`,
      schema: z.object({
        entityName: z.string().optional().describe('Name of the entity to start from (case-insensitive partial match)'),
        entityId: z.string().optional().describe('ID of the entity to start from (exact match, takes precedence over entityName)'),
        depth: z.number().optional().describe('How many hops to traverse (1-3, default 1)'),
      }),
    }
  );
}

function formatTraversalResult(
  nodes: GraphNode[],
  edges: GraphEdge[],
  depth: number,
  truncated: boolean,
  totalNodes: number
): string {
  const sections: string[] = [];

  // Group nodes by type
  const byType = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const list = byType.get(node.type) ?? [];
    list.push(node);
    byType.set(node.type, list);
  }

  sections.push(`NEIGHBORHOOD (depth=${depth}, ${nodes.length} nodes, ${edges.length} edges)${truncated ? ` [truncated from ${totalNodes}]` : ''}`);

  // Nodes by type
  sections.push('\nNODES:');
  for (const [type, typeNodes] of byType) {
    sections.push(`  [${type}] (${typeNodes.length})`);
    for (const node of typeNodes.slice(0, 20)) {
      const desc = node.description ? ` — ${node.description.substring(0, 100)}` : '';
      sections.push(`    - ${node.name} (id: ${node.id})${desc}`);
    }
    if (typeNodes.length > 20) {
      sections.push(`    ... and ${typeNodes.length - 20} more`);
    }
  }

  // Edges
  if (edges.length > 0) {
    sections.push('\nEDGES:');
    const displayEdges = edges.slice(0, 30);
    for (const edge of displayEdges) {
      sections.push(`  (${edge.sourceId}) -[${edge.type}]-> (${edge.targetId})`);
    }
    if (edges.length > 30) {
      sections.push(`  ... and ${edges.length - 30} more edges`);
    }
  }

  return sections.join('\n');
}
