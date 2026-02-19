import { tool } from '../../types/tool-factory.ts';
import { z } from 'zod';
import type { StructuredTool } from '../../types/llm-types.ts';
import type { SqliteStore, EntityRow, RelationshipRow } from '../../knowledge/sqlite-store.ts';
import type { KnowledgeConfig } from '../../knowledge/types.ts';
import { buildGraphSchemaDescription } from './knowledge-tools-factory.ts';

const MAX_NODES = 50;

/**
 * Create a graph traversal tool for a knowledge base with entities.
 * Gets the neighborhood around an entity (N hops).
 */
export function createKnowledgeTraverseTool(
  name: string,
  config: KnowledgeConfig,
  sqliteStore: SqliteStore
): StructuredTool {
  const schemaInfo = buildGraphSchemaDescription(config);

  return tool(
    async ({ entityName, entityId, depth }) => {
      const effectiveDepth = Math.min(Math.max(depth ?? 1, 1), 3);
      let targetId = entityId;

      // If name given but no ID, search for a matching entity
      if (!targetId && entityName) {
        try {
          const allEntities = sqliteStore.getAllEntities();
          const nameLower = entityName.toLowerCase();
          const match = allEntities.find(
            (e) => e.name.toLowerCase() === nameLower || e.name.toLowerCase().includes(nameLower)
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
        const { entities, relationships } = sqliteStore.getNeighborhood(targetId, effectiveDepth);

        if (entities.length === 0) {
          return `No neighbors found for entity "${targetId}" at depth ${effectiveDepth}.`;
        }

        const truncated = entities.length > MAX_NODES;
        const displayEntities = entities.slice(0, MAX_NODES);

        return formatTraversalResult(displayEntities, relationships, effectiveDepth, truncated, entities.length);
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
  entities: EntityRow[],
  relationships: RelationshipRow[],
  depth: number,
  truncated: boolean,
  totalNodes: number
): string {
  const sections: string[] = [];

  // Group entities by type
  const byType = new Map<string, EntityRow[]>();
  for (const entity of entities) {
    const list = byType.get(entity.type) ?? [];
    list.push(entity);
    byType.set(entity.type, list);
  }

  sections.push(`NEIGHBORHOOD (depth=${depth}, ${entities.length} nodes, ${relationships.length} edges)${truncated ? ` [truncated from ${totalNodes}]` : ''}`);

  sections.push('\nNODES:');
  for (const [type, typeEntities] of byType) {
    sections.push(`  [${type}] (${typeEntities.length})`);
    for (const entity of typeEntities.slice(0, 20)) {
      const desc = entity.description ? ` — ${entity.description.substring(0, 100)}` : '';
      sections.push(`    - ${entity.name} (id: ${entity.id})${desc}`);
    }
    if (typeEntities.length > 20) {
      sections.push(`    ... and ${typeEntities.length - 20} more`);
    }
  }

  if (relationships.length > 0) {
    sections.push('\nEDGES:');
    const displayEdges = relationships.slice(0, 30);
    for (const edge of displayEdges) {
      sections.push(`  (${edge.source_id}) -[${edge.type}]-> (${edge.target_id})`);
    }
    if (relationships.length > 30) {
      sections.push(`  ... and ${relationships.length - 30} more edges`);
    }
  }

  return sections.join('\n');
}
