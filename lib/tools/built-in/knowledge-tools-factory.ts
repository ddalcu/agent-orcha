import type { StructuredTool } from '../../types/llm-types.ts';
import type { KnowledgeStoreInstance, KnowledgeConfig } from '../../knowledge/types.ts';
import type { SqliteStore } from '../../knowledge/sqlite-store.ts';
import { createKnowledgeSearchTool } from './knowledge-search.tool.ts';
import { createKnowledgeTraverseTool } from './knowledge-traverse.tool.ts';
import { createKnowledgeEntityLookupTool } from './knowledge-entity-lookup.tool.ts';
import { createKnowledgeGraphSchemaTool } from './knowledge-graph-schema.tool.ts';
import { createKnowledgeSqlTool } from './knowledge-sql.tool.ts';
import { createLogger } from '../../logger.ts';

const logger = createLogger('KnowledgeToolsFactory');

/**
 * Create the full toolset for a knowledge base based on its type.
 *
 * - All KBs get: search
 * - KBs with entities get: search + traverse + entity_lookup + graph_schema
 * - Database-sourced KBs additionally get: sql
 */
export function createKnowledgeTools(
  name: string,
  store: KnowledgeStoreInstance,
  sqliteStore?: SqliteStore
): StructuredTool[] {
  const config = store.config;
  const tools: StructuredTool[] = [];

  // 1. Always create search tool
  tools.push(createKnowledgeSearchTool(name, store));

  // 2. Graph tools — if entities exist in the SQLite store
  if (sqliteStore && sqliteStore.getEntityCount() > 0) {
    tools.push(createKnowledgeTraverseTool(name, config, sqliteStore));
    tools.push(createKnowledgeEntityLookupTool(name, config, sqliteStore));
    tools.push(createKnowledgeGraphSchemaTool(name, config, sqliteStore));
  }

  // 3. SQL tool — if backed by a database source
  if (config.source.type === 'database') {
    tools.push(createKnowledgeSqlTool(name, config));
  }

  logger.info(`Created ${tools.length} knowledge tool(s) for "${name}": ${tools.map((t) => t.name).join(', ')}`);

  return tools;
}

/**
 * Build a human-readable schema description from a knowledge config with graph.
 * Used in tool descriptions to help LLMs understand the graph structure.
 */
export function buildGraphSchemaDescription(config: KnowledgeConfig): string {
  const sections: string[] = [];

  sections.push(`Knowledge base: "${config.name}" — ${config.description ?? ''}`);

  if (!config.graph?.directMapping) return sections.join('\n');

  const mapping = config.graph.directMapping;

  const entityLines = mapping.entities.map((e: any) => {
    const props = (e.properties as any[]).map((p: any) =>
      typeof p === 'string' ? p : Object.values(p)[0]
    );
    return `  ${e.type}: ${props.join(', ')}`;
  });
  sections.push(`ENTITY TYPES:\n${entityLines.join('\n')}`);

  if (mapping.relationships && mapping.relationships.length > 0) {
    const relLines = mapping.relationships.map(
      (r: any) => `  (${r.source}) -[${r.type}]-> (${r.target})`
    );
    sections.push(`RELATIONSHIPS:\n${relLines.join('\n')}`);
  }

  return sections.join('\n');
}
