import { tool } from '../../types/tool-factory.ts';
import { z } from 'zod';
import type { StructuredTool } from '../../types/llm-types.ts';
import type { GraphStore } from '../../knowledge/graph-rag/types.ts';
import type { KnowledgeConfig, GraphRagKnowledgeConfig } from '../../knowledge/types.ts';

/**
 * Create a graph schema discovery tool for a graph-rag knowledge base.
 * Shows entity types, relationship types, and counts.
 */
export function createKnowledgeGraphSchemaTool(
  name: string,
  config: KnowledgeConfig,
  graphStore: GraphStore
): StructuredTool {
  const graphConfig = (config as GraphRagKnowledgeConfig).graph;

  return tool(
    async ({ includeExamples }) => {
      try {
        const allNodes = await graphStore.getAllNodes();
        const allEdges = await graphStore.getAllEdges();

        // Group nodes by type
        const nodesByType = new Map<string, typeof allNodes>();
        for (const node of allNodes) {
          const list = nodesByType.get(node.type) ?? [];
          list.push(node);
          nodesByType.set(node.type, list);
        }

        // Group edges by type
        const edgesByType = new Map<string, typeof allEdges>();
        for (const edge of allEdges) {
          const list = edgesByType.get(edge.type) ?? [];
          list.push(edge);
          edgesByType.set(edge.type, list);
        }

        const sections: string[] = [];

        sections.push(`GRAPH SCHEMA for "${name}"`);
        sections.push(`Total: ${allNodes.length} nodes, ${allEdges.length} edges\n`);

        // Entity types
        sections.push('ENTITY TYPES:');
        for (const [type, nodes] of nodesByType) {
          if (type === 'KnowledgeBase') continue; // Skip meta-node

          // Collect property keys from this type
          const propKeys = new Set<string>();
          for (const node of nodes.slice(0, 20)) {
            for (const key of Object.keys(node.properties)) {
              propKeys.add(key);
            }
          }

          sections.push(`  ${type} (${nodes.length} entities)`);
          if (propKeys.size > 0) {
            sections.push(`    Properties: ${Array.from(propKeys).join(', ')}`);
          }

          if (includeExamples) {
            const examples = nodes
              .filter((n) => n.type !== 'KnowledgeBase')
              .slice(0, 3);
            for (const ex of examples) {
              const desc = ex.description ? ` — ${ex.description.substring(0, 80)}` : '';
              sections.push(`    Example: ${ex.name}${desc}`);
            }
          }
        }

        // Relationship types
        sections.push('\nRELATIONSHIP TYPES:');
        for (const [type, edges] of edgesByType) {
          if (type === 'BELONGS_TO_KB') continue; // Skip meta-relationship
          sections.push(`  ${type} (${edges.length} relationships)`);

          if (includeExamples && edges.length > 0) {
            const examples = edges.slice(0, 3);
            for (const ex of examples) {
              const desc = ex.description ? ` — ${ex.description.substring(0, 80)}` : '';
              sections.push(`    Example: (${ex.sourceId}) -[${type}]-> (${ex.targetId})${desc}`);
            }
          }
        }

        // Configured types from YAML (for reference)
        if (graphConfig.extractionMode === 'direct' && graphConfig.directMapping) {
          sections.push('\nCONFIGURED MAPPING (from YAML):');
          for (const entity of graphConfig.directMapping.entities) {
            const props = (entity.properties as any[]).map((p: any) =>
              typeof p === 'string' ? p : Object.values(p)[0]
            );
            sections.push(`  Entity: ${entity.type} (id: ${entity.idColumn}, name: ${entity.nameColumn ?? entity.idColumn})`);
            sections.push(`    Mapped properties: ${props.join(', ')}`);
          }
          if (graphConfig.directMapping.relationships) {
            for (const rel of graphConfig.directMapping.relationships) {
              sections.push(`  Relationship: (${rel.source}) -[${rel.type}]-> (${rel.target})`);
            }
          }
        } else if (graphConfig.extraction?.entityTypes) {
          sections.push('\nCONFIGURED TYPES (from YAML):');
          sections.push(`  Entity types: ${graphConfig.extraction.entityTypes.map((e) => e.name).join(', ')}`);
          if (graphConfig.extraction.relationshipTypes) {
            sections.push(`  Relationship types: ${graphConfig.extraction.relationshipTypes.map((r) => r.name).join(', ')}`);
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

TIPS: Call with includeExamples=true to see sample entities of each type. Use the entity types and relationship types from the output to write precise Cypher or traversal queries.`,
      schema: z.object({
        includeExamples: z.boolean().optional().describe('Include 2-3 example entities per type (default: false)'),
      }),
    }
  );
}
