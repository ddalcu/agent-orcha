import { tool } from '../../types/tool-factory.ts';
import { z } from 'zod';
import type { StructuredTool } from '../../types/llm-types.ts';
import type { KnowledgeConfig, DatabaseSourceConfig } from '../../knowledge/types.ts';
import { getPool, getDatabaseType } from '../../knowledge/utils/connection-pool.ts';
import { validateReadonlySql } from './query-validators.ts';

/**
 * Create a SQL query tool for a knowledge base backed by a database source.
 */
export function createKnowledgeSqlTool(
  name: string,
  config: KnowledgeConfig
): StructuredTool {
  const dbSource = config.source as DatabaseSourceConfig;
  const dbType = getDatabaseType(dbSource.connectionString);
  const exampleQueries = buildSqlExamples(dbSource);

  return tool(
    async ({ query, limit }) => {
      const validation = validateReadonlySql(query);
      if (!validation.valid) {
        return `Query rejected: ${validation.reason}`;
      }

      const effectiveLimit = Math.min(limit ?? 25, 100);

      // Append LIMIT if not already present
      const hasLimit = /\bLIMIT\b/i.test(query);
      const finalQuery = hasLimit ? query : `${query.trimEnd()}\nLIMIT ${effectiveLimit}`;

      try {
        const pool = getPool(dbSource.connectionString);

        if (dbType === 'postgresql') {
          return await executePostgresReadonly(pool, finalQuery);
        } else {
          return await executeMysqlReadonly(pool, finalQuery);
        }
      } catch (error) {
        return `SQL query error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    {
      name: `knowledge_sql_${name}`,
      description: `Run a readonly SQL query against the "${name}" source database (${dbType}).

SOURCE QUERY (shows available tables/columns):
${dbSource.query.trim()}

Content column: ${dbSource.contentColumn}
${dbSource.metadataColumns ? `Metadata columns: ${dbSource.metadataColumns.join(', ')}` : ''}

EXAMPLE QUERIES:
${exampleQueries}

RESTRICTIONS: Only SELECT queries allowed. No INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, CREATE, GRANT, or REVOKE.

TIPS: Use this when you need precise filtering, aggregation, or joins that semantic search can't provide. The source query above shows the tables and columns available.`,
      schema: z.object({
        query: z.string().describe('A readonly SQL SELECT query'),
        limit: z.number().optional().describe('Max rows to return (default 25, max 100). Ignored if query already has LIMIT.'),
      }),
    }
  );
}

async function executePostgresReadonly(pool: any, query: string): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ ONLY');
    const result = await client.query(query);
    await client.query('COMMIT');

    if (!result.rows || result.rows.length === 0) {
      return 'Query returned no results.';
    }

    return JSON.stringify(result.rows, null, 2);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function executeMysqlReadonly(pool: any, query: string): Promise<string> {
  const connection = await pool.getConnection();
  try {
    await connection.query('START TRANSACTION READ ONLY');
    const [rows] = await connection.query(query);
    await connection.query('COMMIT');

    if (!rows || (Array.isArray(rows) && rows.length === 0)) {
      return 'Query returned no results.';
    }

    return JSON.stringify(rows, null, 2);
  } catch (error) {
    await connection.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

function buildSqlExamples(dbSource: DatabaseSourceConfig): string {
  // Parse table names from the original query
  const tableMatch = dbSource.query.match(/FROM\s+"?(\w+)"?/i);
  const tableName = tableMatch ? tableMatch[1] : 'table';

  const contentCol = dbSource.contentColumn;
  const metaCols = dbSource.metadataColumns ?? [];

  const examples: string[] = [];

  // Count query
  examples.push(`- SELECT COUNT(*) FROM "${tableName}"`);

  // Simple select with content
  if (metaCols.length > 0) {
    const selectCols = metaCols.slice(0, 3).map((c) => `"${c}"`).join(', ');
    examples.push(`- SELECT ${selectCols} FROM "${tableName}" LIMIT 10`);
  }

  // Content search
  examples.push(`- SELECT "${contentCol}" FROM "${tableName}" WHERE "${contentCol}" ILIKE '%keyword%' LIMIT 10`);

  // Aggregate if there's a useful column
  if (metaCols.length > 1) {
    examples.push(`- SELECT "${metaCols[0]}", COUNT(*) as cnt FROM "${tableName}" GROUP BY "${metaCols[0]}" ORDER BY cnt DESC LIMIT 10`);
  }

  return examples.join('\n');
}
