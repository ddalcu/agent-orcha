import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { StructuredTool } from '@langchain/core/tools';
import type { GraphStore } from '../../knowledge/graph-rag/types.js';
import type { KnowledgeConfig, GraphRagKnowledgeConfig } from '../../knowledge/types.js';
import { validateReadonlyCypher } from './query-validators.js';
import { buildGraphSchemaDescription } from './knowledge-tools-factory.js';

/**
 * Create a Cypher query tool for a Neo4j-backed graph-rag knowledge base.
 */
export function createKnowledgeCypherTool(
  name: string,
  config: KnowledgeConfig,
  graphStore: GraphStore
): StructuredTool {
  const schemaInfo = buildGraphSchemaDescription(config as GraphRagKnowledgeConfig);

  const entityTypes = getEntityTypes(config as GraphRagKnowledgeConfig);
  const relTypes = getRelationshipTypes(config as GraphRagKnowledgeConfig);
  const exampleQueries = buildCypherExamples(entityTypes, relTypes);

  return tool(
    async ({ query, params, limit }) => {
      const validation = validateReadonlyCypher(query);
      if (!validation.valid) {
        return `Query rejected: ${validation.reason}`;
      }

      if (!graphStore.query) {
        return 'Error: This graph store does not support raw Cypher queries.';
      }

      // Append LIMIT if not already present
      const effectiveLimit = Math.min(limit ?? 25, 100);
      const hasLimit = /\bLIMIT\b/i.test(query);
      const finalQuery = hasLimit ? query : `${query.trimEnd()}\nLIMIT ${effectiveLimit}`;

      try {
        const results = await graphStore.query(finalQuery, params ?? {});

        if (results.length === 0) {
          return 'Query returned no results.';
        }

        return JSON.stringify(results, null, 2);
      } catch (error) {
        return `Cypher query error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    {
      name: `knowledge_cypher_${name}`,
      description: `Run a readonly Cypher query against the "${name}" Neo4j knowledge graph.

${schemaInfo}

EXAMPLE QUERIES:
${exampleQueries}

RESTRICTIONS: Only read queries allowed (MATCH, RETURN, WITH, WHERE, ORDER BY, UNION, UNWIND, OPTIONAL MATCH). No CREATE, DELETE, MERGE, SET, REMOVE, or DROP.

TIPS: Use this for precise queries when you know the graph schema. For exploratory questions, prefer knowledge_search_${name} or knowledge_traverse_${name}.`,
      schema: z.object({
        query: z.string().describe('A readonly Cypher query (MATCH ... RETURN ...)'),
        params: z.record(z.unknown()).optional().describe('Query parameters (e.g. { name: "value" })'),
        limit: z.number().optional().describe('Max results to return (default 25, max 100). Ignored if query already has LIMIT.'),
      }),
    }
  );
}

function getEntityTypes(config: GraphRagKnowledgeConfig): string[] {
  if (config.graph.extractionMode === 'direct' && config.graph.directMapping) {
    return config.graph.directMapping.entities.map((e: any) => e.type);
  }
  if (config.graph.extraction?.entityTypes) {
    return config.graph.extraction.entityTypes.map((e) => e.name);
  }
  return [];
}

function getRelationshipTypes(config: GraphRagKnowledgeConfig): string[] {
  if (config.graph.extractionMode === 'direct' && config.graph.directMapping) {
    return (config.graph.directMapping.relationships ?? []).map((r: any) => r.type);
  }
  if (config.graph.extraction?.relationshipTypes) {
    return config.graph.extraction.relationshipTypes.map((r) => r.name);
  }
  return [];
}

function buildCypherExamples(entityTypes: string[], relTypes: string[]): string {
  const examples: string[] = [];
  const firstEntity = entityTypes[0];
  const secondEntity = entityTypes[1];
  const firstRel = relTypes[0];

  if (firstEntity) {
    examples.push(`- MATCH (n:Entity) WHERE n.type = '${firstEntity}' RETURN n.name, n.description LIMIT 10`);
    examples.push(`- MATCH (n:Entity) WHERE n.type = '${firstEntity}' RETURN count(n) AS total`);
  }

  if (firstEntity && secondEntity && firstRel) {
    examples.push(`- MATCH (a:Entity)-[r:\`${firstRel}\`]->(b:Entity) WHERE a.type = '${secondEntity}' RETURN a.name, r.type, b.name LIMIT 20`);
  }

  if (firstEntity) {
    examples.push(`- MATCH (n:Entity) WHERE n.name CONTAINS 'keyword' RETURN n.name, n.type, n.description`);
  }

  examples.push(`- MATCH (n:Entity) RETURN DISTINCT n.type AS type, count(*) AS count ORDER BY count DESC`);

  return examples.join('\n');
}
