import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createKnowledgeSqlTool } from '../../lib/tools/built-in/knowledge-sql.tool.ts';

// --- Realistic config: e-commerce orders database ---

const POSTGRES_CONFIG = {
  name: 'orders-db',
  description: 'Customer orders database',
  source: {
    type: 'database' as const,
    connectionString: 'postgresql://shop_user:secret@db.example.com:5432/shopdb',
    query: 'SELECT o.id, o.status, o.total, c.name as customer_name, c.email FROM orders o JOIN customers c ON o.customer_id = c.id',
    contentColumn: 'customer_name',
    metadataColumns: ['id', 'status', 'total', 'email'],
  },
  loader: { type: 'text' as const },
  splitter: { type: 'character' as const, chunkSize: 500, chunkOverlap: 50 },
  embedding: 'default',
};

const MYSQL_CONFIG = {
  ...POSTGRES_CONFIG,
  name: 'mysql-orders',
  source: {
    ...POSTGRES_CONFIG.source,
    connectionString: 'mysql://shop_user:secret@db.example.com:3306/shopdb',
  },
};

const MINIMAL_CONFIG = {
  ...POSTGRES_CONFIG,
  name: 'minimal-db',
  source: {
    type: 'database' as const,
    connectionString: 'postgresql://localhost/testdb',
    query: 'SELECT content FROM documents',
    contentColumn: 'content',
    metadataColumns: undefined as string[] | undefined,
  },
};

describe('createKnowledgeSqlTool', () => {
  it('should create tool with correct name', () => {
    const tool = createKnowledgeSqlTool('orders-db', POSTGRES_CONFIG as any);
    assert.equal(tool.name, 'knowledge_sql_orders-db');
  });

  it('should detect postgresql database type in description', () => {
    const tool = createKnowledgeSqlTool('orders-db', POSTGRES_CONFIG as any);
    assert.ok(tool.description.includes('postgresql'));
  });

  it('should detect mysql database type in description', () => {
    const tool = createKnowledgeSqlTool('mysql-orders', MYSQL_CONFIG as any);
    assert.ok(tool.description.includes('mysql'));
  });

  it('should include table schema in description', () => {
    const tool = createKnowledgeSqlTool('orders-db', POSTGRES_CONFIG as any);
    assert.ok(tool.description.includes('Tables:'));
    assert.ok(tool.description.includes('orders'));
    assert.ok(tool.description.includes('customers'));
  });

  it('should include SELECT restriction in description', () => {
    const tool = createKnowledgeSqlTool('orders-db', POSTGRES_CONFIG as any);
    assert.ok(tool.description.includes('Only SELECT allowed'));
  });

  it('should reject DELETE queries', async () => {
    const tool = createKnowledgeSqlTool('orders-db', POSTGRES_CONFIG as any);
    const result = await tool.invoke({ query: 'DELETE FROM orders WHERE id = 1' });
    assert.ok(result.includes('rejected'));
  });

  it('should reject INSERT queries', async () => {
    const tool = createKnowledgeSqlTool('orders-db', POSTGRES_CONFIG as any);
    const result = await tool.invoke({ query: "INSERT INTO orders (status) VALUES ('new')" });
    assert.ok(result.includes('rejected'));
  });

  it('should reject UPDATE queries', async () => {
    const tool = createKnowledgeSqlTool('orders-db', POSTGRES_CONFIG as any);
    const result = await tool.invoke({ query: "UPDATE orders SET status = 'cancelled'" });
    assert.ok(result.includes('rejected'));
  });

  it('should reject DROP queries', async () => {
    const tool = createKnowledgeSqlTool('orders-db', POSTGRES_CONFIG as any);
    const result = await tool.invoke({ query: 'DROP TABLE orders' });
    assert.ok(result.includes('rejected'));
  });

  it('should reject TRUNCATE queries', async () => {
    const tool = createKnowledgeSqlTool('orders-db', POSTGRES_CONFIG as any);
    const result = await tool.invoke({ query: 'TRUNCATE TABLE orders' });
    assert.ok(result.includes('rejected'));
  });

  it('should reject ALTER queries', async () => {
    const tool = createKnowledgeSqlTool('orders-db', POSTGRES_CONFIG as any);
    const result = await tool.invoke({ query: 'ALTER TABLE orders ADD COLUMN notes TEXT' });
    assert.ok(result.includes('rejected'));
  });

  it('should reject empty queries', async () => {
    const tool = createKnowledgeSqlTool('orders-db', POSTGRES_CONFIG as any);
    const result = await tool.invoke({ query: '   ' });
    assert.ok(result.includes('rejected'));
  });
});
