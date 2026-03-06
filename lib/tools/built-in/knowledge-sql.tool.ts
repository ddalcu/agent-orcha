import { DatabaseSync } from 'node:sqlite';
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
  const tableSchema = extractTableSchema(dbSource, dbType);

  return tool(
    async ({ query, limit }) => {
      const validation = validateReadonlySql(query);
      if (!validation.valid) {
        return `Query rejected: ${validation.reason}`;
      }

      const effectiveLimit = Math.min(limit ?? 25, 100);

      // Strip trailing semicolons and append LIMIT if not already present
      const trimmed = query.trimEnd().replace(/;+$/, '');
      const hasLimit = /\bLIMIT\b/i.test(trimmed);
      const finalQuery = hasLimit ? trimmed : `${trimmed}\nLIMIT ${effectiveLimit}`;

      try {
        const pool = getPool(dbSource.connectionString);

        if (dbType === 'sqlite') {
          return executeSqliteReadonly(pool as DatabaseSync, finalQuery);
        } else if (dbType === 'postgresql') {
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
      description: `Run a readonly SELECT query against "${name}" database (${dbType}). ${tableSchema} Only SELECT allowed.`,
      schema: z.object({
        query: z.string().describe(`A readonly ${dbType} SELECT query`),
        limit: z.number().optional().describe('Max rows (default 25, max 100)'),
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

function executeSqliteReadonly(db: DatabaseSync, query: string): string {
  const rows = db.prepare(query).all();

  if (!rows || rows.length === 0) {
    return 'Query returned no results.';
  }

  return JSON.stringify(rows, null, 2);
}

/**
 * Extract a compact "Table(col1, col2, ...)" schema from the source query.
 * Parses FROM/JOIN clauses for table names and SELECT for column names.
 */
function extractTableSchema(dbSource: DatabaseSourceConfig, dbType: string): string {
  const query = dbSource.query;

  // Extract table names with aliases from FROM and JOIN clauses
  const tablePattern = /(?:FROM|JOIN)\s+"?(\w+)"?(?:\s+(?:AS\s+)?(\w+))?/gi;
  const tables = new Map<string, string>(); // alias/name -> table name
  let match;
  while ((match = tablePattern.exec(query)) !== null) {
    const tableName = match[1]!;
    const alias = match[2] ?? tableName;
    tables.set(alias.toLowerCase(), tableName);
  }

  if (tables.size === 0) return '';

  // Extract column references from SELECT clause(s)
  // Map columns to their table by alias prefix (e.g., "t.Name" -> Track)
  const columnsByTable = new Map<string, Set<string>>();
  for (const table of tables.values()) {
    columnsByTable.set(table, new Set());
  }

  // Match "alias.column AS label" or "alias.column"
  const colPattern = /(\w+)\.(\w+)(?:\s+AS\s+(\w+))?/gi;
  while ((match = colPattern.exec(query)) !== null) {
    const alias = match[1]!.toLowerCase();
    const col = match[2]!;
    const table = tables.get(alias);
    if (table && col !== '*') {
      columnsByTable.get(table)!.add(col);
    }
  }

  const parts: string[] = [];
  for (const [table, cols] of columnsByTable) {
    if (cols.size > 0) {
      parts.push(`${table}(${[...cols].join(', ')})`);
    } else {
      parts.push(table);
    }
  }

  const schema = `Tables: ${parts.join(', ')}.`;
  const example = buildExampleQuery(columnsByTable, dbType);
  return example ? `${schema} ${example}` : schema;
}

/**
 * Build a compact example SELECT from the first two tables,
 * joining on a shared column name, using dialect-appropriate syntax.
 */
function buildExampleQuery(columnsByTable: Map<string, Set<string>>, dbType: string): string {
  const entries = [...columnsByTable.entries()];
  if (entries.length === 0) return '';

  const q = dbType === 'mysql' ? (s: string) => `\`${s}\`` : (s: string) => s;

  const [t1, cols1] = entries[0]!;
  const a1 = t1[0]!.toLowerCase();

  if (entries.length < 2 || cols1.size === 0) {
    const col = cols1.size > 0 ? [...cols1][0]! : '*';
    return `e.g. SELECT ${q(col)} FROM ${q(t1)}`;
  }

  const [t2, cols2] = entries[1]!;
  const a2 = t2[0]!.toLowerCase() === a1 ? t2.substring(0, 2).toLowerCase() : t2[0]!.toLowerCase();

  // Find a shared column for the JOIN condition
  const shared = [...cols1].find(c => cols2.has(c)) ?? [...cols2].find(c => c.toLowerCase().endsWith('id'));
  const joinCol = shared ?? 'id';

  const selectCol = [...cols1].find(c => !c.toLowerCase().endsWith('id')) ?? [...cols1][0] ?? '*';

  return `e.g. SELECT ${a1}.${q(selectCol)} FROM ${q(t1)} ${a1} JOIN ${q(t2)} ${a2} ON ${a1}.${q(joinCol)} = ${a2}.${q(joinCol)}`;
}

