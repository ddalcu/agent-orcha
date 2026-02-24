import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createMemorySaveTool } from '../../lib/tools/built-in/memory-save.tool.ts';
import { MemoryManager } from '../../lib/memory/memory-manager.ts';

describe('createMemorySaveTool', () => {
  let tempDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-save-'));
    manager = new MemoryManager(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should create a tool with correct name', () => {
    const tool = createMemorySaveTool(manager, 'test-agent', 100);
    assert.equal(tool.name, 'save_memory');
    assert.ok(tool.description.includes('memory'));
  });

  it('should save content and return success message', async () => {
    const tool = createMemorySaveTool(manager, 'test-agent', 100);
    const result = await tool.invoke({ content: 'Line 1\nLine 2\nLine 3' });
    assert.ok(result.includes('3 lines'));

    // Verify content was saved
    const loaded = await manager.load('test-agent', 100);
    assert.ok(loaded.includes('Line 1'));
  });

  it('should count lines correctly for single line', async () => {
    const tool = createMemorySaveTool(manager, 'test-agent', 100);
    const result = await tool.invoke({ content: 'Single line' });
    assert.ok(result.includes('1 lines'));
  });
});
