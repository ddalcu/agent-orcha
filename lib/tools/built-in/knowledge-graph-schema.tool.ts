import { tool } from '../../types/tool-factory.ts';
import { z } from 'zod';
import type { StructuredTool } from '../../types/llm-types.ts';
import type { SqliteStore } from '../../knowledge/sqlite-store.ts';
import type { KnowledgeConfig } from '../../knowledge/types.ts';

/**
 * Create a graph schema discovery tool for a knowledge base with entities.
 * Shows entity types, relationship types, and counts.
 */
export function createKnowledgeGraphSchemaTool(
  name: string,
  config: KnowledgeConfig,
  sqliteStore: SqliteStore
): StructuredTool {
  return tool(
    async ({ includeExamples }) => {
      try {
        const allEntities = sqliteStore.getAllEntities();
        const allRelationships = sqliteStore.getAllRelationships();

        // Group entities by type
        const entitiesByType = new Map<string, typeof allEntities>();
        for (const entity of allEntities) {
          const list = entitiesByType.get(entity.type) ?? [];
          list.push(entity);
          entitiesByType.set(entity.type, list);
        }

        // Group relationships by type
        const relsByType = new Map<string, typeof allRelationships>();
        for (const rel of allRelationships) {
          const list = relsByType.get(rel.type) ?? [];
          list.push(rel);
          relsByType.set(rel.type, list);
        }

        const sections: string[] = [];

        sections.push(`GRAPH SCHEMA for "${name}"`);
        sections.push(`Total: ${allEntities.length} entities, ${allRelationships.length} relationships\n`);

        // Entity types
        sections.push('ENTITY TYPES:');
        for (const [type, entities] of entitiesByType) {
          // Collect property keys from this type
          const propKeys = new Set<string>();
          for (const entity of entities.slice(0, 20)) {
            try {
              const props = JSON.parse(entity.properties);
              for (const key of Object.keys(props)) {
                propKeys.add(key);
              }
            } catch { /* */ }
          }

          sections.push(`  ${type} (${entities.length} entities)`);
          if (propKeys.size > 0) {
            sections.push(`    Properties: ${Array.from(propKeys).join(', ')}`);
          }

          if (includeExamples) {
            const examples = entities.slice(0, 3);
            for (const ex of examples) {
              const desc = ex.description ? ` — ${ex.description.substring(0, 80)}` : '';
              sections.push(`    Example: ${ex.name}${desc}`);
            }
          }
        }

        // Relationship types
        sections.push('\nRELATIONSHIP TYPES:');
        for (const [type, rels] of relsByType) {
          sections.push(`  ${type} (${rels.length} relationships)`);

          if (includeExamples && rels.length > 0) {
            const examples = rels.slice(0, 3);
            for (const ex of examples) {
              const desc = ex.description ? ` — ${ex.description.substring(0, 80)}` : '';
              sections.push(`    Example: (${ex.source_id}) -[${type}]-> (${ex.target_id})${desc}`);
            }
          }
        }

        // Configured types from YAML (for reference)
        if (config.graph) {
          if (config.graph.extractionMode === 'direct' && config.graph.directMapping) {
            sections.push('\nCONFIGURED MAPPING (from YAML):');
            for (const entity of config.graph.directMapping.entities) {
              const props = (entity.properties as any[]).map((p: any) =>
                typeof p === 'string' ? p : Object.values(p)[0]
              );
              sections.push(`  Entity: ${entity.type} (id: ${entity.idColumn}, name: ${entity.nameColumn ?? entity.idColumn})`);
              sections.push(`    Mapped properties: ${props.join(', ')}`);
            }
            if (config.graph.directMapping.relationships) {
              for (const rel of config.graph.directMapping.relationships) {
                sections.push(`  Relationship: (${rel.source}) -[${rel.type}]-> (${rel.target})`);
              }
            }
          } else if (config.graph.extraction?.entityTypes) {
            sections.push('\nCONFIGURED TYPES (from YAML):');
            sections.push(`  Entity types: ${config.graph.extraction.entityTypes.map((e) => e.name).join(', ')}`);
            if (config.graph.extraction.relationshipTypes) {
              sections.push(`  Relationship types: ${config.graph.extraction.relationshipTypes.map((r) => r.name).join(', ')}`);
            }
          }
        }

        return sections.join('\n');
      } catch (error) {
        return `Schema discovery error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    {
      name: `knowledge_graph_schema_${name}`,
      description: `Discover the schema of the "${name}" knowledge graph — entity types, relationship types, property names, counts, and database table definitions. Use this FIRST when exploring an unfamiliar graph to understand its structure before running queries.

TIPS: Call with includeExamples=true to see sample entities of each type. Use the entity types and relationship types from the output to write precise traversal queries.`,
      schema: z.object({
        includeExamples: z.boolean().optional().describe('Include 2-3 example entities per type (default: false)'),
      }),
    }
  );
}
