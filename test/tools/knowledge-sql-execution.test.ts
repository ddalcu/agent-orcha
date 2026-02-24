import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createKnowledgeSqlTool } from '../../lib/tools/built-in/knowledge-sql.tool.ts';

// Create a real SQLite database for testing execution paths
let dbPath: string;
let db: DatabaseSync;

before(() => {
  dbPath = path.join(os.tmpdir(), `orcha-test-${Date.now()}.db`);
  db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT,
      price REAL
    )
  `);
  db.exec(`
    INSERT INTO products (name, category, price) VALUES
      ('Widget A', 'gadgets', 9.99),
      ('Widget B', 'gadgets', 19.99),
      ('Gizmo C', 'tools', 29.99)
  `);
  db.close();
});

after(() => {
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
});

function createSqliteConfig(dbFile: string) {
  return {
    name: 'test-products',
    description: 'Test products DB',
    source: {
      type: 'database' as const,
      connectionString: `sqlite://${dbFile}`,
      query: 'SELECT id, name, category, price FROM products',
      contentColumn: 'name',
      metadataColumns: ['id', 'category', 'price'],
    },
    loader: { type: 'text' as const },
    splitter: { type: 'character' as const, chunkSize: 500, chunkOverlap: 50 },
    embedding: 'default',
  };
}

describe('knowledge-sql execution (SQLite)', () => {
  it('should execute a SELECT query and return results', async () => {
    const config = createSqliteConfig(dbPath);
    const tool = createKnowledgeSqlTool('test-products', config as any);
    const result = await tool.invoke({ query: 'SELECT name, price FROM products ORDER BY price' });
    const rows = JSON.parse(result as string);
    assert.ok(Array.isArray(rows));
    assert.equal(rows.length, 3);
    assert.equal(rows[0].name, 'Widget A');
    assert.equal(rows[0].price, 9.99);
  });

  it('should return "no results" message for empty result set', async () => {
    const config = createSqliteConfig(dbPath);
    const tool = createKnowledgeSqlTool('test-products', config as any);
    const result = await tool.invoke({ query: "SELECT * FROM products WHERE name = 'nonexistent'" });
    assert.equal(result, 'Query returned no results.');
  });

  it('should append LIMIT when query has no LIMIT clause', async () => {
    const config = createSqliteConfig(dbPath);
    const tool = createKnowledgeSqlTool('test-products', config as any);
    // Query without LIMIT — tool should append LIMIT 25 by default
    const result = await tool.invoke({ query: 'SELECT * FROM products' });
    const rows = JSON.parse(result as string);
    assert.ok(Array.isArray(rows));
    // All 3 rows returned (fewer than default limit of 25)
    assert.equal(rows.length, 3);
  });

  it('should not append LIMIT when query already has one', async () => {
    const config = createSqliteConfig(dbPath);
    const tool = createKnowledgeSqlTool('test-products', config as any);
    const result = await tool.invoke({ query: 'SELECT * FROM products LIMIT 2' });
    const rows = JSON.parse(result as string);
    assert.equal(rows.length, 2);
  });

  it('should respect custom limit parameter', async () => {
    const config = createSqliteConfig(dbPath);
    const tool = createKnowledgeSqlTool('test-products', config as any);
    const result = await tool.invoke({ query: 'SELECT * FROM products', limit: 1 });
    const rows = JSON.parse(result as string);
    assert.equal(rows.length, 1);
  });

  it('should cap limit at 100', async () => {
    const config = createSqliteConfig(dbPath);
    const tool = createKnowledgeSqlTool('test-products', config as any);
    // Pass limit > 100, tool should cap at 100
    const result = await tool.invoke({ query: 'SELECT * FROM products', limit: 500 });
    const rows = JSON.parse(result as string);
    // Only 3 rows exist, so we get all 3 (but limit was capped at 100)
    assert.equal(rows.length, 3);
  });

  it('should return error for invalid SQL', async () => {
    const config = createSqliteConfig(dbPath);
    const tool = createKnowledgeSqlTool('test-products', config as any);
    const result = await tool.invoke({ query: 'SELECT * FROM nonexistent_table' });
    assert.ok((result as string).includes('SQL query error'));
  });

  it('should reject write queries', async () => {
    const config = createSqliteConfig(dbPath);
    const tool = createKnowledgeSqlTool('test-products', config as any);
    const result = await tool.invoke({ query: "INSERT INTO products (name) VALUES ('hacked')" });
    assert.ok((result as string).includes('rejected'));
  });
});

describe('knowledge-sql execution (PostgreSQL connection error)', () => {
  it('should return SQL error for unreachable PostgreSQL', async () => {
    const config = {
      name: 'pg-test',
      description: 'Test',
      source: {
        type: 'database' as const,
        connectionString: 'postgresql://nobody:nopass@127.0.0.1:19999/nodb',
        query: 'SELECT id, name FROM items',
        contentColumn: 'name',
        metadataColumns: ['id'],
      },
      loader: { type: 'text' as const },
      splitter: { type: 'character' as const, chunkSize: 500, chunkOverlap: 50 },
      embedding: 'default',
    };
    const tool = createKnowledgeSqlTool('pg-test', config as any);
    const result = await tool.invoke({ query: 'SELECT * FROM items' });
    assert.ok((result as string).includes('SQL query error'));
  });
});

describe('knowledge-sql buildSqlExamples', () => {
  it('should use LIKE for SQLite instead of ILIKE', () => {
    const config = createSqliteConfig(dbPath);
    const tool = createKnowledgeSqlTool('test-products', config as any);
    assert.ok(tool.description.includes('LIKE'));
    assert.ok(!tool.description.includes('ILIKE'));
  });

  it('should use ILIKE for PostgreSQL', () => {
    const config = {
      ...createSqliteConfig(dbPath),
      source: {
        type: 'database' as const,
        connectionString: 'postgresql://localhost/testdb',
        query: 'SELECT id, name FROM items',
        contentColumn: 'name',
        metadataColumns: ['id', 'category'],
      },
    };
    const tool = createKnowledgeSqlTool('pg-test', config as any);
    assert.ok(tool.description.includes('ILIKE'));
  });

  it('should use LIKE for MySQL', () => {
    const config = {
      ...createSqliteConfig(dbPath),
      source: {
        type: 'database' as const,
        connectionString: 'mysql://localhost/testdb',
        query: 'SELECT id, name FROM items',
        contentColumn: 'name',
        metadataColumns: ['id'],
      },
    };
    const tool = createKnowledgeSqlTool('mysql-test', config as any);
    assert.ok(tool.description.includes('LIKE'));
    assert.ok(!tool.description.includes('ILIKE'));
  });

  it('should fallback to "table" when FROM clause has no match', () => {
    const config = {
      ...createSqliteConfig(dbPath),
      source: {
        type: 'database' as const,
        connectionString: 'sqlite://' + dbPath,
        query: 'VALUES (1)',
        contentColumn: 'name',
        metadataColumns: undefined as string[] | undefined,
      },
    };
    const tool = createKnowledgeSqlTool('fallback-test', config as any);
    assert.ok(tool.description.includes('"table"'));
  });
});
