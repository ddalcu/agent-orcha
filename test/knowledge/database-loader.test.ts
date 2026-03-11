import { describe, it, before, after } from 'node:test';
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
});
