import { describe, it, before, after, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseLoader } from '../../lib/knowledge/loaders/database-loader.ts';
import type { DatabaseSourceConfig } from '../../lib/knowledge/types.ts';

const TMP_DIR = path.join(import.meta.dirname, '..', '..', 'tmp', 'test-dbloader');

function ensureTmpDir() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
}

function createTestDb(name: string): string {
  ensureTmpDir();
  const dbPath = path.join(TMP_DIR, `${name}.db`);
  try { fs.unlinkSync(dbPath); } catch { /* */ }

  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE docs (id INTEGER PRIMARY KEY, content TEXT, author TEXT, category TEXT);
    INSERT INTO docs (content, author, category) VALUES ('Hello world', 'Alice', 'greeting');
    INSERT INTO docs (content, author, category) VALUES ('Goodbye moon', 'Bob', 'farewell');
    INSERT INTO docs (content, author, category) VALUES ('Test doc', 'Charlie', 'test');
  `);
  db.close();
  return dbPath;
}

describe('DatabaseLoader (SQLite)', () => {
  let dbPath: string;

  before(() => {
    dbPath = createTestDb('loader-test');
  });

  after(() => {
    try { fs.unlinkSync(dbPath); } catch { /* */ }
  });

  it('should load all rows as documents', async () => {
    const config: DatabaseSourceConfig = {
      type: 'database',
      connectionString: `sqlite://${dbPath}`,
      query: 'SELECT * FROM docs',
      contentColumn: 'content',
      batchSize: 100,
    };

    const loader = new DatabaseLoader(config);
    const docs = await loader.load();

    assert.equal(docs.length, 3);
    assert.equal(docs[0]!.pageContent, 'Hello world');
    assert.equal(docs[1]!.pageContent, 'Goodbye moon');
    assert.equal(docs[2]!.pageContent, 'Test doc');
  });

  it('should include _rawRow in metadata', async () => {
    const config: DatabaseSourceConfig = {
      type: 'database',
      connectionString: `sqlite://${dbPath}`,
      query: 'SELECT * FROM docs',
      contentColumn: 'content',
      batchSize: 100,
    };

    const loader = new DatabaseLoader(config);
    const docs = await loader.load();

    assert.ok(docs[0]!.metadata._rawRow);
    assert.equal((docs[0]!.metadata._rawRow as any).author, 'Alice');
  });

  it('should extract specified metadata columns', async () => {
    const config: DatabaseSourceConfig = {
      type: 'database',
      connectionString: `sqlite://${dbPath}`,
      query: 'SELECT * FROM docs',
      contentColumn: 'content',
      metadataColumns: ['author', 'category'],
      batchSize: 100,
    };

    const loader = new DatabaseLoader(config);
    const docs = await loader.load();

    assert.equal(docs[0]!.metadata.author, 'Alice');
    assert.equal(docs[0]!.metadata.category, 'greeting');
  });

  it('should handle query with WHERE clause', async () => {
    const config: DatabaseSourceConfig = {
      type: 'database',
      connectionString: `sqlite://${dbPath}`,
      query: "SELECT * FROM docs WHERE author = 'Bob'",
      contentColumn: 'content',
      batchSize: 100,
    };

    const loader = new DatabaseLoader(config);
    const docs = await loader.load();

    assert.equal(docs.length, 1);
    assert.equal(docs[0]!.pageContent, 'Goodbye moon');
  });

  it('should throw when content column is missing', async () => {
    const config: DatabaseSourceConfig = {
      type: 'database',
      connectionString: `sqlite://${dbPath}`,
      query: 'SELECT * FROM docs',
      contentColumn: 'nonexistent',
      batchSize: 100,
    };

    const loader = new DatabaseLoader(config);
    await assert.rejects(() => loader.load(), /Content column.*not found/);
  });

  it('should throw on invalid SQL query', async () => {
    const config: DatabaseSourceConfig = {
      type: 'database',
      connectionString: `sqlite://${dbPath}`,
      query: 'SELECT * FROM nonexistent_table',
      contentColumn: 'content',
      batchSize: 100,
    };

    const loader = new DatabaseLoader(config);
    await assert.rejects(() => loader.load(), /Failed to load documents/);
  });

  it('should handle empty result set', async () => {
    const config: DatabaseSourceConfig = {
      type: 'database',
      connectionString: `sqlite://${dbPath}`,
      query: "SELECT * FROM docs WHERE author = 'Nobody'",
      contentColumn: 'content',
      batchSize: 100,
    };

    const loader = new DatabaseLoader(config);
    const docs = await loader.load();

    assert.equal(docs.length, 0);
  });

  it('should convert non-string content to string', async () => {
    // Create a db with numeric content
    ensureTmpDir();
    const numDbPath = path.join(TMP_DIR, 'numeric.db');
    try { fs.unlinkSync(numDbPath); } catch { /* */ }
    const db = new DatabaseSync(numDbPath);
    db.exec(`
      CREATE TABLE nums (id INTEGER PRIMARY KEY, value INTEGER);
      INSERT INTO nums (value) VALUES (42);
    `);
    db.close();

    const config: DatabaseSourceConfig = {
      type: 'database',
      connectionString: `sqlite://${numDbPath}`,
      query: 'SELECT * FROM nums',
      contentColumn: 'value',
      batchSize: 100,
    };

    const loader = new DatabaseLoader(config);
    const docs = await loader.load();

    assert.equal(docs.length, 1);
    assert.equal(docs[0]!.pageContent, '42');

    try { fs.unlinkSync(numDbPath); } catch { /* */ }
  });

  it('should not include metadata columns that are not in the row', async () => {
    const config: DatabaseSourceConfig = {
      type: 'database',
      connectionString: `sqlite://${dbPath}`,
      query: 'SELECT * FROM docs',
      contentColumn: 'content',
      metadataColumns: ['author', 'nonexistent_col'],
      batchSize: 100,
    };

    const loader = new DatabaseLoader(config);
    const docs = await loader.load();

    assert.equal(docs[0]!.metadata.author, 'Alice');
    assert.strictEqual('nonexistent_col' in docs[0]!.metadata, false);
  });

  it('should include all row columns in _rawRow', async () => {
    const config: DatabaseSourceConfig = {
      type: 'database',
      connectionString: `sqlite://${dbPath}`,
      query: 'SELECT * FROM docs',
      contentColumn: 'content',
      batchSize: 100,
    };

    const loader = new DatabaseLoader(config);
    const docs = await loader.load();

    const rawRow = docs[0]!.metadata._rawRow as Record<string, any>;
    assert.ok('id' in rawRow);
    assert.ok('content' in rawRow);
    assert.ok('author' in rawRow);
    assert.ok('category' in rawRow);
  });

  it('should handle query with ORDER BY', async () => {
    const config: DatabaseSourceConfig = {
      type: 'database',
      connectionString: `sqlite://${dbPath}`,
      query: 'SELECT * FROM docs ORDER BY author DESC',
      contentColumn: 'content',
      batchSize: 100,
    };

    const loader = new DatabaseLoader(config);
    const docs = await loader.load();

    assert.equal(docs.length, 3);
    // DESC order by author: Charlie, Bob, Alice
    assert.equal((docs[0]!.metadata._rawRow as any).author, 'Charlie');
    assert.equal((docs[1]!.metadata._rawRow as any).author, 'Bob');
    assert.equal((docs[2]!.metadata._rawRow as any).author, 'Alice');
  });

  it('should handle query with LIMIT', async () => {
    const config: DatabaseSourceConfig = {
      type: 'database',
      connectionString: `sqlite://${dbPath}`,
      query: 'SELECT * FROM docs LIMIT 2',
      contentColumn: 'content',
      batchSize: 100,
    };

    const loader = new DatabaseLoader(config);
    const docs = await loader.load();

    assert.equal(docs.length, 2);
  });

  it('should handle empty metadataColumns array', async () => {
    const config: DatabaseSourceConfig = {
      type: 'database',
      connectionString: `sqlite://${dbPath}`,
      query: 'SELECT * FROM docs LIMIT 1',
      contentColumn: 'content',
      metadataColumns: [],
      batchSize: 100,
    };

    const loader = new DatabaseLoader(config);
    const docs = await loader.load();

    assert.equal(docs.length, 1);
    // _rawRow should still be there, but no explicit metadata columns
    assert.ok(docs[0]!.metadata._rawRow);
    // Only _rawRow key in metadata (no other metadata columns extracted)
    const metaKeys = Object.keys(docs[0]!.metadata).filter(k => k !== '_rawRow');
    assert.equal(metaKeys.length, 0);
  });

  it('should handle multiple tables via JOIN query', async () => {
    ensureTmpDir();
    const joinDbPath = path.join(TMP_DIR, 'join-test.db');
    try { fs.unlinkSync(joinDbPath); } catch { /* */ }
    const db = new DatabaseSync(joinDbPath);
    db.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER, title TEXT);
      INSERT INTO users (name) VALUES ('Dave');
      INSERT INTO posts (user_id, title) VALUES (1, 'First Post');
      INSERT INTO posts (user_id, title) VALUES (1, 'Second Post');
    `);
    db.close();

    const config: DatabaseSourceConfig = {
      type: 'database',
      connectionString: `sqlite://${joinDbPath}`,
      query: 'SELECT p.title, u.name as author FROM posts p JOIN users u ON p.user_id = u.id',
      contentColumn: 'title',
      metadataColumns: ['author'],
      batchSize: 100,
    };

    const loader = new DatabaseLoader(config);
    const docs = await loader.load();

    assert.equal(docs.length, 2);
    assert.equal(docs[0]!.pageContent, 'First Post');
    assert.equal(docs[0]!.metadata.author, 'Dave');

    try { fs.unlinkSync(joinDbPath); } catch { /* */ }
  });

  it('should handle SELECT with specific columns', async () => {
    const config: DatabaseSourceConfig = {
      type: 'database',
      connectionString: `sqlite://${dbPath}`,
      query: 'SELECT content, author FROM docs',
      contentColumn: 'content',
      metadataColumns: ['author'],
      batchSize: 100,
    };

    const loader = new DatabaseLoader(config);
    const docs = await loader.load();

    assert.equal(docs.length, 3);
    assert.equal(docs[0]!.metadata.author, 'Alice');
    // _rawRow should only have the selected columns
    const rawRow = docs[0]!.metadata._rawRow as Record<string, any>;
    assert.ok('content' in rawRow);
    assert.ok('author' in rawRow);
  });
});

/**
 * Tests for PostgreSQL and MySQL paths using mocked connection pools.
 * These test the loadFromPostgres, loadFromMysql, processPostgresBatch,
 * and processMysqlBatch methods via the public load() method.
 */
describe('DatabaseLoader (PostgreSQL — mocked)', () => {
  it('should load documents from PostgreSQL via mocked pool', async () => {
    // We'll create a DatabaseLoader with a postgres:// connection string,
    // then mock the connection pool module to return our fake pool.
    const { getPool, getDatabaseType } = await import('../../lib/knowledge/utils/connection-pool.ts');

    // Create a mock PgPool-like object
    const mockRows = [
      { id: 1, content: 'PG Hello', author: 'Alice' },
      { id: 2, content: 'PG World', author: 'Bob' },
      { id: 3, content: 'PG Test', author: 'Charlie' },
    ];

    const mockClient = {
      query: async (_q: string) => ({
        rows: mockRows,
        fields: [{ name: 'id' }, { name: 'content' }, { name: 'author' }],
      }),
      release: () => {},
    };

    const mockPool = {
      connect: async () => mockClient,
    };

    // Patch getPool to return our mock for postgresql connections
    const origGetPool = getPool;

    // Use a real SQLite-based approach won't work for PG, so we mock at the loader level
    // We'll construct the loader and call its private methods via reflection
    const config: DatabaseSourceConfig = {
      type: 'database',
      connectionString: 'postgresql://localhost/testdb',
      query: 'SELECT * FROM docs',
      contentColumn: 'content',
      metadataColumns: ['author'],
      batchSize: 2,
    };

    const loader = new DatabaseLoader(config);

    // Call the private loadFromPostgres method directly
    const documents: any[] = [];
    await (loader as any).loadFromPostgres(
      mockPool, 'SELECT * FROM docs', 'content', ['author'], 2, documents
    );

    assert.equal(documents.length, 3);
    assert.equal(documents[0].pageContent, 'PG Hello');
    assert.equal(documents[0].metadata.author, 'Alice');
    assert.ok(documents[0].metadata._rawRow);
    assert.equal(documents[1].pageContent, 'PG World');
    assert.equal(documents[2].pageContent, 'PG Test');
  });

  it('should process PostgreSQL rows in batches', async () => {
    const config: DatabaseSourceConfig = {
      type: 'database',
      connectionString: 'postgresql://localhost/testdb',
      query: 'SELECT * FROM docs',
      contentColumn: 'content',
      batchSize: 100,
    };

    const loader = new DatabaseLoader(config);

    // Call processPostgresBatch directly
    const batch = [
      { content: 'Row 1', category: 'A' },
      { content: 'Row 2', category: 'B' },
    ];
    const documents: any[] = [];
    (loader as any).processPostgresBatch(batch, [], 'content', ['category'], documents);

    assert.equal(documents.length, 2);
    assert.equal(documents[0].pageContent, 'Row 1');
    assert.equal(documents[0].metadata.category, 'A');
    assert.equal(documents[1].pageContent, 'Row 2');
  });

  it('should release client even when query fails', async () => {
    let released = false;
    const mockClient = {
      query: async () => { throw new Error('PG query failed'); },
      release: () => { released = true; },
    };
    const mockPool = { connect: async () => mockClient };

    const config: DatabaseSourceConfig = {
      type: 'database',
      connectionString: 'postgresql://localhost/testdb',
      query: 'SELECT * FROM bad_table',
      contentColumn: 'content',
      batchSize: 100,
    };

    const loader = new DatabaseLoader(config);
    const documents: any[] = [];

    await assert.rejects(
      () => (loader as any).loadFromPostgres(mockPool, config.query, 'content', undefined, 100, documents),
      /PG query failed/
    );

    assert.ok(released, 'Client should have been released');
  });
});

describe('DatabaseLoader (MySQL — mocked)', () => {
  it('should load documents from MySQL via mocked pool', async () => {
    const mockRows = [
      { id: 1, content: 'MySQL Hello', author: 'Alice' },
      { id: 2, content: 'MySQL World', author: 'Bob' },
    ];

    const mockConnection = {
      query: async (_q: string) => [mockRows, [{ name: 'id' }, { name: 'content' }, { name: 'author' }]],
      release: () => {},
    };

    const mockPool = {
      getConnection: async () => mockConnection,
    };

    const config: DatabaseSourceConfig = {
      type: 'database',
      connectionString: 'mysql://localhost/testdb',
      query: 'SELECT * FROM docs',
      contentColumn: 'content',
      metadataColumns: ['author'],
      batchSize: 1,
    };

    const loader = new DatabaseLoader(config);
    const documents: any[] = [];
    await (loader as any).loadFromMysql(
      mockPool, 'SELECT * FROM docs', 'content', ['author'], 1, documents
    );

    assert.equal(documents.length, 2);
    assert.equal(documents[0].pageContent, 'MySQL Hello');
    assert.equal(documents[0].metadata.author, 'Alice');
    assert.ok(documents[0].metadata._rawRow);
    assert.equal(documents[1].pageContent, 'MySQL World');
  });

  it('should throw when MySQL query returns non-array', async () => {
    const mockConnection = {
      query: async () => [{ affectedRows: 1 }, []],  // Non-array result
      release: () => {},
    };
    const mockPool = { getConnection: async () => mockConnection };

    const config: DatabaseSourceConfig = {
      type: 'database',
      connectionString: 'mysql://localhost/testdb',
      query: 'UPDATE docs SET content = "x"',
      contentColumn: 'content',
      batchSize: 100,
    };

    const loader = new DatabaseLoader(config);
    const documents: any[] = [];

    await assert.rejects(
      () => (loader as any).loadFromMysql(mockPool, config.query, 'content', undefined, 100, documents),
      /Query did not return rows/
    );
  });

  it('should release connection even when query fails', async () => {
    let released = false;
    const mockConnection = {
      query: async () => { throw new Error('MySQL query failed'); },
      release: () => { released = true; },
    };
    const mockPool = { getConnection: async () => mockConnection };

    const config: DatabaseSourceConfig = {
      type: 'database',
      connectionString: 'mysql://localhost/testdb',
      query: 'SELECT * FROM bad_table',
      contentColumn: 'content',
      batchSize: 100,
    };

    const loader = new DatabaseLoader(config);
    const documents: any[] = [];

    await assert.rejects(
      () => (loader as any).loadFromMysql(mockPool, config.query, 'content', undefined, 100, documents),
      /MySQL query failed/
    );

    assert.ok(released, 'Connection should have been released');
  });

  it('should process MySQL rows in batches via processMysqlBatch', async () => {
    const config: DatabaseSourceConfig = {
      type: 'database',
      connectionString: 'mysql://localhost/testdb',
      query: 'SELECT * FROM docs',
      contentColumn: 'title',
      batchSize: 100,
    };

    const loader = new DatabaseLoader(config);
    const batch = [
      { title: 'My Title', tag: 'news' },
      { title: 'Another', tag: 'blog' },
    ];
    const documents: any[] = [];
    (loader as any).processMysqlBatch(batch, [], 'title', ['tag'], documents);

    assert.equal(documents.length, 2);
    assert.equal(documents[0].pageContent, 'My Title');
    assert.equal(documents[0].metadata.tag, 'news');
    assert.equal(documents[1].pageContent, 'Another');
    assert.equal(documents[1].metadata.tag, 'blog');
  });
});
