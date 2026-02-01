import type { StructuredTool } from '@langchain/core/tools';
import type { KnowledgeStoreInstance, GraphRagKnowledgeConfig } from '../../knowledge/types.js';
import { GraphRagFactory } from '../../knowledge/graph-rag/graph-rag-factory.js';
import { Neo4jGraphStore } from '../../knowledge/graph-rag/neo4j-graph-store.js';
import { createKnowledgeSearchTool } from './knowledge-search.tool.js';
import { createKnowledgeCypherTool } from './knowledge-cypher.tool.js';
import { createKnowledgeTraverseTool } from './knowledge-traverse.tool.js';
import { createKnowledgeEntityLookupTool } from './knowledge-entity-lookup.tool.js';
import { createKnowledgeGraphSchemaTool } from './knowledge-graph-schema.tool.js';
import { createKnowledgeSqlTool } from './knowledge-sql.tool.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('KnowledgeToolsFactory');

/**
 * Create the full toolset for a knowledge base based on its type.
 *
 * - Vector KBs get: search
 * - Graph-rag KBs get: search + traverse + entity_lookup + graph_schema (+ cypher if Neo4j)
 * - Database-sourced KBs additionally get: sql
 */
export function createKnowledgeTools(name: string, store: KnowledgeStoreInstance): StructuredTool[] {
  const config = store.config;
  const tools: StructuredTool[] = [];

  // 1. Always create search tool
  tools.push(createKnowledgeSearchTool(name, store));

  // 2. Graph-rag tools
  if (config.kind === 'graph-rag') {
    const graphStore = GraphRagFactory.getGraphStore(name);

    if (graphStore) {
      // Cypher tool — only for Neo4j stores
      if (graphStore instanceof Neo4jGraphStore) {
        tools.push(createKnowledgeCypherTool(name, config, graphStore));
      }

      // Traverse, entity lookup, and schema tools — any graph store
      tools.push(createKnowledgeTraverseTool(name, config, graphStore));
      tools.push(createKnowledgeEntityLookupTool(name, config, graphStore));
      tools.push(createKnowledgeGraphSchemaTool(name, config, graphStore));
    } else {
      logger.warn(`No graph store found for "${name}" — only search tool will be available`);
    }
  }

  // 3. SQL tool — if backed by a database source
  if (config.source.type === 'database') {
    tools.push(createKnowledgeSqlTool(name, config));
  }

  logger.info(`Created ${tools.length} knowledge tool(s) for "${name}": ${tools.map((t) => t.name).join(', ')}`);

  return tools;
}

/**
 * Build a human-readable schema description from a graph-rag config.
 * Used in tool descriptions to help LLMs understand the graph structure.
 */
export function buildGraphSchemaDescription(config: GraphRagKnowledgeConfig): string {
  const sections: string[] = [];

  sections.push(`Knowledge base: "${config.name}" — ${config.description ?? ''}`);

  if (config.graph.extractionMode === 'direct' && config.graph.directMapping) {
    const mapping = config.graph.directMapping;

    // Entity types with properties
    const entityLines = mapping.entities.map((e: any) => {
      const props = (e.properties as any[]).map((p: any) =>
        typeof p === 'string' ? p : Object.values(p)[0]
      );
      return `  ${e.type}: ${props.join(', ')}`;
    });
    sections.push(`ENTITY TYPES:\n${entityLines.join('\n')}`);

    // Relationship types
    if (mapping.relationships && mapping.relationships.length > 0) {
      const relLines = mapping.relationships.map(
        (r: any) => `  (${r.source}) -[${r.type}]-> (${r.target})`
      );
      sections.push(`RELATIONSHIPS:\n${relLines.join('\n')}`);
    }
  } else if (config.graph.extraction?.entityTypes) {
    const entityNames = config.graph.extraction.entityTypes.map((e) => e.name);
    sections.push(`ENTITY TYPES: ${entityNames.join(', ')}`);

    if (config.graph.extraction.relationshipTypes) {
      const relNames = config.graph.extraction.relationshipTypes.map((r) => r.name);
      sections.push(`RELATIONSHIP TYPES: ${relNames.join(', ')}`);
    }
  }

  return sections.join('\n');
}
