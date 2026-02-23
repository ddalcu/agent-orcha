import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { KnowledgeMetadataManager, createDefaultMetadata } from '../../lib/knowledge/knowledge-store-metadata.ts';
import { createTempDir, cleanupDir } from '../helpers/mock-fs.ts';

describe('createDefaultMetadata', () => {
  it('should create default vector metadata', () => {
    const meta = createDefaultMetadata('my-kb', 'vector');

    assert.equal(meta.name, 'my-kb');
    assert.equal(meta.kind, 'vector');
    assert.equal(meta.status, 'not_indexed');
    assert.equal(meta.lastIndexedAt, null);
    assert.equal(meta.documentCount, 0);
    assert.equal(meta.chunkCount, 0);
    assert.equal(meta.entityCount, 0);
    assert.equal(meta.edgeCount, 0);
    assert.equal(meta.communityCount, 0);
    assert.equal(meta.errorMessage, null);
  });

  it('should create default graph-rag metadata', () => {
    const meta = createDefaultMetadata('graph-kb', 'graph-rag');
    assert.equal(meta.kind, 'graph-rag');
  });
});

describe('KnowledgeMetadataManager', () => {
  let tempDir: string;
  let manager: KnowledgeMetadataManager;

  before(async () => {
    tempDir = await createTempDir('kb-metadata-test-');
    manager = new KnowledgeMetadataManager(tempDir);
  });

  after(async () => {
    await cleanupDir(tempDir);
  });

  it('should return null for non-existent metadata', async () => {
    const result = await manager.load('nonexistent');
    assert.equal(result, null);
  });

  it('should save and load metadata', async () => {
    const meta = createDefaultMetadata('test-kb', 'vector');
    meta.documentCount = 42;

    await manager.save('test-kb', meta);
    const loaded = await manager.load('test-kb');

    assert.ok(loaded);
    assert.equal(loaded.name, 'test-kb');
    assert.equal(loaded.documentCount, 42);
  });

  it('should get all metadata for known names', async () => {
    const meta1 = createDefaultMetadata('kb1', 'vector');
    const meta2 = createDefaultMetadata('kb2', 'graph-rag');

    await manager.save('kb1', meta1);
    await manager.save('kb2', meta2);

    const all = await manager.getAll(['kb1', 'kb2', 'nonexistent']);

    assert.equal(all.size, 2);
    assert.ok(all.has('kb1'));
    assert.ok(all.has('kb2'));
    assert.equal(all.has('nonexistent'), false);
  });

  it('should set status on existing metadata', async () => {
    const meta = createDefaultMetadata('status-kb', 'vector');
    await manager.save('status-kb', meta);

    await manager.setStatus('status-kb', 'indexing');
    const loaded = await manager.load('status-kb');

    assert.ok(loaded);
    assert.equal(loaded.status, 'indexing');
  });

  it('should set error message with status', async () => {
    const meta = createDefaultMetadata('error-kb', 'vector');
    await manager.save('error-kb', meta);

    await manager.setStatus('error-kb', 'error', 'Something broke');
    const loaded = await manager.load('error-kb');

    assert.ok(loaded);
    assert.equal(loaded.status, 'error');
    assert.equal(loaded.errorMessage, 'Something broke');
  });

  it('should skip setStatus for non-existent metadata', async () => {
    // Should not throw
    await manager.setStatus('ghost', 'error');
  });

  it('should delete metadata directory', async () => {
    const meta = createDefaultMetadata('delete-me', 'vector');
    await manager.save('delete-me', meta);

    await manager.delete('delete-me');

    const loaded = await manager.load('delete-me');
    assert.equal(loaded, null);
  });

  it('should not throw when deleting non-existent', async () => {
    await manager.delete('no-such-kb');
  });

  it('should return cache directory path', () => {
    const dir = manager.getCacheDir('some-kb');
    assert.ok(dir.includes('some-kb'));
  });

  it('should reset stale indexing status', async () => {
    const meta = createDefaultMetadata('stale-kb', 'vector');
    meta.status = 'indexing';
    await manager.save('stale-kb', meta);

    await manager.resetStaleIndexing(['stale-kb']);

    const loaded = await manager.load('stale-kb');
    assert.ok(loaded);
    assert.equal(loaded.status, 'error');
    assert.ok(loaded.errorMessage!.includes('interrupted'));
  });

  it('should not reset non-indexing status', async () => {
    const meta = createDefaultMetadata('ok-kb', 'vector');
    meta.status = 'indexed';
    await manager.save('ok-kb', meta);

    await manager.resetStaleIndexing(['ok-kb']);

    const loaded = await manager.load('ok-kb');
    assert.ok(loaded);
    assert.equal(loaded.status, 'indexed');
  });

  it('should expose baseDir', () => {
    assert.equal(manager.baseDir, tempDir);
  });
});
