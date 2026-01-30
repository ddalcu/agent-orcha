import { Pool as PgPool } from 'pg';
import mysql from 'mysql2/promise';
import { createLogger } from '../../logger.js';

const logger = createLogger('ConnectionPool');

type ConnectionPool = PgPool | mysql.Pool;

// Singleton map of connection pools keyed by connection string
const poolCache = new Map<string, ConnectionPool>();

/**
 * Get or create a connection pool for the given connection string.
 * Uses singleton pattern to prevent "too many connections" errors.
 */
export function getPool(connectionString: string): ConnectionPool {
  // Check cache first
  if (poolCache.has(connectionString)) {
    logger.info(`Reusing existing connection pool`);
    return poolCache.get(connectionString)!;
  }

  logger.info(`Creating new connection pool`);

  // Detect database type from connection string
  const isPostgres = connectionString.startsWith('postgres://') || connectionString.startsWith('postgresql://');
  const isMysql = connectionString.startsWith('mysql://');

  if (!isPostgres && !isMysql) {
    throw new Error(`Unsupported database type. Connection string must start with postgresql:// or mysql://`);
  }

  let pool: ConnectionPool;

  if (isPostgres) {
    logger.info(`Creating PostgreSQL connection pool`);
    pool = new PgPool({
      connectionString,
      max: 10, // Maximum pool size
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
  } else {
    logger.info(`Creating MySQL connection pool`);
    pool = mysql.createPool({
      uri: connectionString,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      idleTimeout: 30000,
    });
  }

  // Cache the pool
  poolCache.set(connectionString, pool);

  return pool;
}

/**
 * Close all connection pools (useful for graceful shutdown)
 */
export async function closeAllPools(): Promise<void> {
  logger.info(`Closing ${poolCache.size} connection pool(s)`);

  for (const [connString, pool] of poolCache.entries()) {
    try {
      if ('end' in pool) {
        await pool.end();
      }
      poolCache.delete(connString);
    } catch (error) {
      logger.error(`Error closing pool: ${error}`);
    }
  }
}

/**
 * Detect database type from connection string
 */
export function getDatabaseType(connectionString: string): 'postgresql' | 'mysql' {
  if (connectionString.startsWith('postgres://') || connectionString.startsWith('postgresql://')) {
    return 'postgresql';
  }
  if (connectionString.startsWith('mysql://')) {
    return 'mysql';
  }
  throw new Error(`Unsupported database type in connection string: ${connectionString}`);
}
