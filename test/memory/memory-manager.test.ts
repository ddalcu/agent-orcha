import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import { MemoryManager } from '../../lib/memory/memory-manager.ts';
import { createTempDir, cleanupDir } from '../helpers/mock-fs.ts';

describe('MemoryManager', () => {
  let tempDir: string;
  let manager: MemoryManager;

  before(async () => {
    tempDir = await createTempDir('memory-manager-test-');
    manager = new MemoryManager(tempDir);
  });

  after(async () => {
    await cleanupDir(tempDir);
  });

  it('should return empty string for non-existent agent memory', async () => {
    const result = await manager.load('nonexistent');
    assert.equal(result, '');
  });

  it('should save and load agent memory', async () => {
    await manager.save('test-agent', 'Memory content here');
    const result = await manager.load('test-agent');
    assert.equal(result, 'Memory content here');
  });

  it('should create .memory directory on save', async () => {
    await manager.save('test-agent', 'content');
    const memoryDir = path.join(tempDir, '.memory');

    const stats = await fs.stat(memoryDir);
    assert.ok(stats.isDirectory());
  });

  it('should truncate content to maxLines', async () => {
    const content = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n');

    await manager.save('truncated', content, 50);
    const result = await manager.load('truncated');

    const lines = result.split('\n');
    assert.equal(lines.length, 50);
    assert.equal(lines[0], 'line 151'); // Should keep last 50 lines
    assert.equal(lines[49], 'line 200');
  });

  it('should not truncate when content is within maxLines', async () => {
    const content = 'line1\nline2\nline3';

    await manager.save('short', content, 100);
    const result = await manager.load('short');

    assert.equal(result, content);
  });

  it('should overwrite existing memory', async () => {
    await manager.save('overwrite', 'first');
    await manager.save('overwrite', 'second');
    const result = await manager.load('overwrite');
    assert.equal(result, 'second');
  });

  it('should delete agent memory', async () => {
    await manager.save('to-delete', 'some memory');
    const before = await manager.load('to-delete');
    assert.equal(before, 'some memory');

    await manager.delete('to-delete');
    const after = await manager.load('to-delete');
    assert.equal(after, '');
  });

  it('should not throw when deleting non-existent memory', async () => {
    // Should not throw
    await manager.delete('never-existed');
  });
});
