import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { SqliteStore } from '../../lib/knowledge/sqlite-store.ts';

const TEST_DB_DIR = path.join(import.meta.dirname, '..', '..', 'tmp', 'test-sqlite');

function getTestDbPath(name: string): string {
  if (!fs.existsSync(TEST_DB_DIR)) {
    fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  }
  return path.join(TEST_DB_DIR, `${name}.db`);
}

function cleanup(dbPath: string): void {
  try { fs.unlinkSync(dbPath); } catch { /* */ }
}

describe('SqliteStore', () => {
  const dbPaths: string[] = [];

  afterEach(() => {
    for (const p of dbPaths) {
      cleanup(p);
    }
    dbPaths.length = 0;
  });

  it('should create and open a store', () => {
    const dbPath = getTestDbPath('create');
    dbPaths.push(dbPath);
    const store = new SqliteStore(dbPath, 4);
    assert.ok(store);
    assert.equal(store.getDimensions(), 4);
    assert.equal(store.getChunkCount(), 0);
    assert.equal(store.getEntityCount(), 0);
    store.close();
  });

  it('should insert and search chunks', () => {
    const dbPath = getTestDbPath('chunks');
    dbPaths.push(dbPath);
    const store = new SqliteStore(dbPath, 4);

    store.insertChunks([
      { content: 'Hello world', metadata: { source: 'test' }, source: 'test.txt', embedding: [1, 0, 0, 0] },
      { content: 'Goodbye world', metadata: { source: 'test' }, source: 'test.txt', embedding: [0, 1, 0, 0] },
      { content: 'Hello again', metadata: { source: 'test' }, source: 'test.txt', embedding: [0.9, 0.1, 0, 0] },
    ]);

    assert.equal(store.getChunkCount(), 3);

    const results = store.searchChunks([1, 0, 0, 0], 2);
    assert.equal(results.length, 2);
    assert.equal(results[0]!.content, 'Hello world');
    assert.ok(results[0]!.score > 0.9);
    assert.equal(results[1]!.content, 'Hello again');

    store.close();
  });

  it('should insert and search entities', () => {
    const dbPath = getTestDbPath('entities');
    dbPaths.push(dbPath);
    const store = new SqliteStore(dbPath, 4);

    store.insertEntities([
      { id: 'person::alice', type: 'Person', name: 'Alice', description: 'A developer', properties: {}, sourceChunkIds: ['chunk-0'], embedding: [1, 0, 0, 0] },
      { id: 'person::bob', type: 'Person', name: 'Bob', description: 'A manager', properties: {}, sourceChunkIds: ['chunk-1'], embedding: [0, 1, 0, 0] },
    ]);

    assert.equal(store.getEntityCount(), 2);

    const results = store.searchEntities([1, 0, 0, 0], 1);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.name, 'Alice');
    assert.ok(results[0]!.score > 0.9);

    store.close();
  });

  it('should get entity by id', () => {
    const dbPath = getTestDbPath('entity-get');
    dbPaths.push(dbPath);
    const store = new SqliteStore(dbPath, 4);

    store.insertEntities([
      { id: 'person::alice', type: 'Person', name: 'Alice', description: 'Dev', properties: { role: 'developer' }, sourceChunkIds: [], embedding: [1, 0, 0, 0] },
    ]);

    const entity = store.getEntity('person::alice');
    assert.ok(entity);
    assert.equal(entity.name, 'Alice');
    assert.equal(entity.type, 'Person');

    const missing = store.getEntity('person::charlie');
    assert.equal(missing, undefined);

    store.close();
  });

  it('should insert and query relationships', () => {
    const dbPath = getTestDbPath('rels');
    dbPaths.push(dbPath);
    const store = new SqliteStore(dbPath, 4);

    store.insertEntities([
      { id: 'person::alice', type: 'Person', name: 'Alice', description: '', properties: {}, sourceChunkIds: [], embedding: [1, 0, 0, 0] },
      { id: 'person::bob', type: 'Person', name: 'Bob', description: '', properties: {}, sourceChunkIds: [], embedding: [0, 1, 0, 0] },
    ]);

    store.insertRelationships([
      { id: 'edge-0', type: 'REPORTS_TO', sourceId: 'person::alice', targetId: 'person::bob', description: 'Alice reports to Bob', weight: 1.0, properties: {} },
    ]);

    assert.equal(store.getRelationshipCount(), 1);

    const allRels = store.getAllRelationships();
    assert.equal(allRels.length, 1);
    assert.equal(allRels[0]!.type, 'REPORTS_TO');

    store.close();
  });

  it('should traverse neighborhoods', () => {
    const dbPath = getTestDbPath('neighborhood');
    dbPaths.push(dbPath);
    const store = new SqliteStore(dbPath, 4);

    store.insertEntities([
      { id: 'a', type: 'Node', name: 'A', description: '', properties: {}, sourceChunkIds: [], embedding: [1, 0, 0, 0] },
      { id: 'b', type: 'Node', name: 'B', description: '', properties: {}, sourceChunkIds: [], embedding: [0, 1, 0, 0] },
      { id: 'c', type: 'Node', name: 'C', description: '', properties: {}, sourceChunkIds: [], embedding: [0, 0, 1, 0] },
    ]);

    store.insertRelationships([
      { id: 'e1', type: 'LINKS_TO', sourceId: 'a', targetId: 'b', description: '', weight: 1, properties: {} },
      { id: 'e2', type: 'LINKS_TO', sourceId: 'b', targetId: 'c', description: '', weight: 1, properties: {} },
    ]);

    // Depth 1 from A should reach B
    const depth1 = store.getNeighborhood('a', 1);
    assert.equal(depth1.entities.length, 2); // A + B
    assert.equal(depth1.relationships.length, 1);

    // Depth 2 from A should reach B and C
    const depth2 = store.getNeighborhood('a', 2);
    assert.equal(depth2.entities.length, 3); // A + B + C
    assert.equal(depth2.relationships.length, 2);

    store.close();
  });

  it('should handle metadata operations', () => {
    const dbPath = getTestDbPath('meta');
    dbPaths.push(dbPath);
    const store = new SqliteStore(dbPath, 4);

    store.setMeta('testKey', 'testValue');
    assert.equal(store.getMeta('testKey'), 'testValue');
    assert.equal(store.getMeta('nonexistent'), undefined);

    store.close();
  });

  it('should persist across reopen', () => {
    const dbPath = getTestDbPath('persist');
    dbPaths.push(dbPath);

    // Write
    const store1 = new SqliteStore(dbPath, 4);
    store1.insertChunks([
      { content: 'persisted', metadata: {}, source: '', embedding: [1, 0, 0, 0] },
    ]);
    store1.setMeta('version', '1');
    store1.close();

    // Read
    const store2 = new SqliteStore(dbPath, 4);
    assert.equal(store2.getChunkCount(), 1);
    assert.equal(store2.getMeta('version'), '1');

    const results = store2.searchChunks([1, 0, 0, 0], 1);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.content, 'persisted');
    store2.close();
  });

  it('should clear all data', () => {
    const dbPath = getTestDbPath('clear');
    dbPaths.push(dbPath);
    const store = new SqliteStore(dbPath, 4);

    store.insertChunks([
      { content: 'test', metadata: {}, source: '', embedding: [1, 0, 0, 0] },
    ]);
    store.insertEntities([
      { id: 'x', type: 'T', name: 'X', description: '', properties: {}, sourceChunkIds: [], embedding: [1, 0, 0, 0] },
    ]);

    assert.ok(store.hasData());

    store.clear();

    assert.equal(store.getChunkCount(), 0);
    assert.equal(store.getEntityCount(), 0);
    assert.ok(!store.hasData());

    store.close();
  });

  it('should handle re-inserting entities with same IDs', () => {
    const dbPath = getTestDbPath('reinsert');
    dbPaths.push(dbPath);
    const store = new SqliteStore(dbPath, 4);

    store.insertEntities([
      { id: 'person::alice', type: 'Person', name: 'Alice', description: 'v1', properties: {}, sourceChunkIds: [], embedding: [1, 0, 0, 0] },
    ]);
    assert.equal(store.getEntityCount(), 1);

    // Re-insert same entity with updated embedding — should not throw
    store.insertEntities([
      { id: 'person::alice', type: 'Person', name: 'Alice', description: 'v2', properties: {}, sourceChunkIds: [], embedding: [0, 1, 0, 0] },
    ]);
    assert.equal(store.getEntityCount(), 1);

    // Verify search uses the updated embedding
    const results = store.searchEntities([0, 1, 0, 0], 1);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.description, 'v2');
    assert.ok(results[0]!.score > 0.9);

    store.close();
  });

  it('should validate dimensions', () => {
    const dbPath = getTestDbPath('dims');
    dbPaths.push(dbPath);

    const store = new SqliteStore(dbPath, 4);
    store.close();

    assert.ok(SqliteStore.validateDimensions(dbPath, 4));
    assert.ok(!SqliteStore.validateDimensions(dbPath, 8));
    assert.ok(SqliteStore.validateDimensions('/nonexistent/path.db', 4));
  });
});
