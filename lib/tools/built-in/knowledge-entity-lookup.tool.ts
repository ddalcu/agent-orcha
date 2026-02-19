import { tool } from '../../types/tool-factory.ts';
import { z } from 'zod';
import type { StructuredTool } from '../../types/llm-types.ts';
import type { SqliteStore, EntityRow } from '../../knowledge/sqlite-store.ts';
import type { KnowledgeConfig } from '../../knowledge/types.ts';
import { buildGraphSchemaDescription } from './knowledge-tools-factory.ts';

/**
 * Create an entity lookup tool for a knowledge base with entities.
 * Find entities by name, ID, or type.
 */
export function createKnowledgeEntityLookupTool(
  name: string,
  config: KnowledgeConfig,
  sqliteStore: SqliteStore
): StructuredTool {
  const schemaInfo = buildGraphSchemaDescription(config);

  return tool(
    async ({ id, name: entityName, type, limit }) => {
      const effectiveLimit = Math.min(limit ?? 10, 50);

      // Direct ID lookup
      if (id) {
        try {
          const entity = sqliteStore.getEntity(id);
          if (!entity) {
            return `No entity found with ID "${id}".`;
          }
          return formatEntities([entity]);
        } catch (error) {
          return `Lookup error: ${error instanceof Error ? error.message : String(error)}`;
        }
      }

      // Name and/or type search
      try {
        const allEntities = sqliteStore.getAllEntities();
        let filtered = allEntities;

        // Filter by type first (exact match, case-insensitive)
        if (type) {
          const typeLower = type.toLowerCase();
          filtered = filtered.filter((e) => e.type.toLowerCase() === typeLower);
        }

        // Filter by name (partial match, case-insensitive)
        if (entityName) {
          const nameLower = entityName.toLowerCase();
          filtered = filtered.filter(
            (e) => e.name.toLowerCase().includes(nameLower) || e.id.toLowerCase().includes(nameLower)
          );
        }

        if (filtered.length === 0) {
          const criteria: string[] = [];
          if (entityName) criteria.push(`name="${entityName}"`);
          if (type) criteria.push(`type="${type}"`);
          return `No entities found matching ${criteria.join(', ')}.`;
        }

        const results = filtered.slice(0, effectiveLimit);
        const total = filtered.length;

        return formatEntities(results, total > effectiveLimit ? total : undefined);
      } catch (error) {
        return `Lookup error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    {
      name: `knowledge_entity_lookup_${name}`,
      description: `Find entities in the "${name}" knowledge graph by name, ID, or type. Returns entity details including properties.

${schemaInfo}

TIPS: Use type filter to browse entities of a specific kind. Use name for searching. Use the returned entity IDs with knowledge_traverse_${name} to explore relationships.`,
      schema: z.object({
        id: z.string().optional().describe('Exact entity ID to look up (takes precedence over name/type filters)'),
        name: z.string().optional().describe('Search entities by name (case-insensitive partial match)'),
        type: z.string().optional().describe('Filter by entity type (case-insensitive exact match)'),
        limit: z.number().optional().describe('Max results to return (default 10, max 50)'),
      }),
    }
  );
}

function formatEntities(entities: EntityRow[], totalCount?: number): string {
  const lines: string[] = [];

  if (totalCount) {
    lines.push(`Found ${totalCount} entities (showing ${entities.length}):\n`);
  } else {
    lines.push(`Found ${entities.length} entity(ies):\n`);
  }

  for (const entity of entities) {
    lines.push(`[${entity.type}] ${entity.name}`);
    lines.push(`  ID: ${entity.id}`);
    if (entity.description) {
      lines.push(`  Description: ${entity.description.substring(0, 200)}`);
    }

    // Show key properties
    try {
      const props = JSON.parse(entity.properties);
      const entries = Object.entries(props).filter(
        ([key]) => !['sourceChunkIds', 'embedding'].includes(key)
      );
      if (entries.length > 0) {
        const propStrs = entries
          .slice(0, 8)
          .map(([k, v]) => {
            const val = typeof v === 'string' && v.length > 80 ? v.substring(0, 80) + '...' : v;
            return `${k}: ${val}`;
          });
        lines.push(`  Properties: ${propStrs.join(', ')}`);
      }
    } catch { /* properties not valid JSON */ }
    lines.push('');
  }

  return lines.join('\n');
}
