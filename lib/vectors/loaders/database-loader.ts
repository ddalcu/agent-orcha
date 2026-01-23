import { BaseDocumentLoader } from '@langchain/core/document_loaders/base';
import { Document } from '@langchain/core/documents';
import type { Pool as PgPool } from 'pg';
import type mysql from 'mysql2/promise';
import { getPool, getDatabaseType } from '../utils/connection-pool.js';
import type { DatabaseSourceConfig } from '../types.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('DatabaseLoader');

/**
 * Database document loader for PostgreSQL and MySQL.
 * Executes SQL queries and transforms rows into LangChain documents.
 */
export class DatabaseLoader extends BaseDocumentLoader {
  private config: DatabaseSourceConfig;

  constructor(config: DatabaseSourceConfig) {
    super();
    this.config = config;
  }

  async load(): Promise<Document[]> {
    const { connectionString, query, contentColumn, metadataColumns, batchSize } = this.config;

    logger.info(`Loading documents from database`);
    logger.info(`Query: ${query.substring(0, 100)}${query.length > 100 ? '...' : ''}`);

    const dbType = getDatabaseType(connectionString);
    const pool = getPool(connectionString);

    const documents: Document[] = [];

    try {
      if (dbType === 'postgresql') {
        await this.loadFromPostgres(pool as PgPool, query, contentColumn, metadataColumns, batchSize, documents);
      } else {
        await this.loadFromMysql(pool as mysql.Pool, query, contentColumn, metadataColumns, batchSize, documents);
      }

      logger.info(`Loaded ${documents.length} document(s) from database`);
      return documents;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Database query failed: ${errorMessage}`);
      throw new Error(`Failed to load documents from database: ${errorMessage}`);
    }
  }

  private async loadFromPostgres(
    pool: PgPool,
    query: string,
    contentColumn: string,
    metadataColumns: string[] | undefined,
    batchSize: number,
    documents: Document[]
  ): Promise<void> {
    const client = await pool.connect();

    try {
      logger.info(`Executing PostgreSQL query`);

      // Execute query and get all results
      const result = await client.query(query);
      const rows = result.rows;
      const fields = result.fields;

      logger.info(`Fetched ${rows.length} row(s)`);

      // Process in batches
      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        this.processPostgresBatch(batch, fields, contentColumn, metadataColumns, documents);
        logger.info(`Processed ${Math.min(i + batchSize, rows.length)} / ${rows.length} row(s)`);
      }
    } finally {
      client.release();
    }
  }

  private async loadFromMysql(
    pool: mysql.Pool,
    query: string,
    contentColumn: string,
    metadataColumns: string[] | undefined,
    batchSize: number,
    documents: Document[]
  ): Promise<void> {
    const connection = await pool.getConnection();

    try {
      logger.info(`Executing MySQL query with batch size ${batchSize}`);

      const [rows, fields] = await connection.query(query);

      if (!Array.isArray(rows)) {
        throw new Error('Query did not return rows');
      }

      logger.info(`Fetched ${rows.length} row(s)`);

      // Process in batches
      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        this.processMysqlBatch(batch, fields, contentColumn, metadataColumns, documents);
        logger.info(`Processed ${Math.min(i + batchSize, rows.length)} / ${rows.length} row(s)`);
      }
    } finally {
      connection.release();
    }
  }

  private processPostgresBatch(
    batch: any[],
    _fields: any[],
    contentColumn: string,
    metadataColumns: string[] | undefined,
    documents: Document[]
  ): void {
    for (const row of batch) {
      // PostgreSQL returns rows as objects, not arrays
      const doc = this.rowToDocument(row as Record<string, any>, contentColumn, metadataColumns);
      documents.push(doc);
    }
  }

  private processMysqlBatch(
    batch: any[],
    _fields: any[],
    contentColumn: string,
    metadataColumns: string[] | undefined,
    documents: Document[]
  ): void {
    for (const row of batch) {
      const doc = this.rowToDocument(row as Record<string, any>, contentColumn, metadataColumns);
      documents.push(doc);
    }
  }

  private rowToDocument(
    row: Record<string, any>,
    contentColumn: string,
    metadataColumns: string[] | undefined
  ): Document {
    // Extract content
    const content = row[contentColumn];

    if (content === null || content === undefined) {
      throw new Error(`Content column "${contentColumn}" not found or is null in row`);
    }

    // Convert content to string if needed
    const pageContent = typeof content === 'string' ? content : String(content);

    // Extract metadata from specified columns
    const metadata: Record<string, any> = {};

    if (metadataColumns && metadataColumns.length > 0) {
      for (const column of metadataColumns) {
        if (column in row) {
          metadata[column] = row[column];
        }
      }
    }

    return new Document({
      pageContent,
      metadata,
    });
  }
}
