import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveSafePath, buildTree, IGNORED, MAX_DEPTH } from '../../lib/utils/file-utils.ts';
import { createTempDir, cleanupDir, writeFixture } from '../helpers/mock-fs.ts';

describe('resolveSafePath', () => {
  let tempDir: string;

  before(async () => {
    tempDir = await createTempDir('safe-path-test-');
    await fs.mkdir(path.join(tempDir, 'subdir'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'subdir', 'file.txt'), 'hello');
  });

  after(async () => {
    await cleanupDir(tempDir);
  });

  it('should resolve a valid relative path', async () => {
    const result = await resolveSafePath(tempDir, 'subdir/file.txt');
    assert.equal(result, path.resolve(tempDir, 'subdir/file.txt'));
  });

  it('should reject absolute paths', async () => {
    await assert.rejects(
      resolveSafePath(tempDir, '/etc/passwd'),
      /Path traversal/
    );
  });

  it('should reject path traversal with ..', async () => {
    await assert.rejects(
      resolveSafePath(tempDir, '../../../etc/passwd'),
      /Path traversal/
    );
  });

  it('should allow paths to non-existent files within base', async () => {
    const result = await resolveSafePath(tempDir, 'subdir/new-file.txt');
    assert.ok(result.startsWith(tempDir));
  });

  it('should reject paths to non-existent directories outside base', async () => {
    await assert.rejects(
      resolveSafePath(tempDir, '../nonexistent/file.txt'),
      /Path traversal/
    );
  });
});

describe('buildTree', () => {
  let tempDir: string;

  before(async () => {
    tempDir = await createTempDir('tree-test-');
    await writeFixture(tempDir, 'file1.txt', 'content1');
    await writeFixture(tempDir, 'file2.md', 'content2');
    await writeFixture(tempDir, 'subdir/nested.txt', 'nested');
    await writeFixture(tempDir, 'node_modules/pkg/index.js', 'ignored');
  });

  after(async () => {
    await cleanupDir(tempDir);
  });

  it('should build a tree of files and directories', async () => {
    const tree = await buildTree(tempDir, tempDir, 0);

    assert.ok(tree.length > 0);

    const names = tree.map(n => n.name);
    assert.ok(names.includes('subdir'));
    assert.ok(names.includes('file1.txt'));
    assert.ok(names.includes('file2.md'));
  });

  it('should include nested files in subdirectories', async () => {
    const tree = await buildTree(tempDir, tempDir, 0);
    const subdir = tree.find(n => n.name === 'subdir');

    assert.ok(subdir);
    assert.equal(subdir.type, 'directory');
    assert.ok(subdir.children);
    assert.ok(subdir.children.some(c => c.name === 'nested.txt'));
  });

  it('should ignore node_modules and other IGNORED entries', async () => {
    const tree = await buildTree(tempDir, tempDir, 0);
    const names = tree.map(n => n.name);

    assert.ok(!names.includes('node_modules'));
  });

  it('should sort directories before files', async () => {
    const tree = await buildTree(tempDir, tempDir, 0);

    // Find first directory and first file indices
    const firstDirIdx = tree.findIndex(n => n.type === 'directory');
    const firstFileIdx = tree.findIndex(n => n.type === 'file');

    if (firstDirIdx >= 0 && firstFileIdx >= 0) {
      assert.ok(firstDirIdx < firstFileIdx);
    }
  });

  it('should respect MAX_DEPTH', async () => {
    const tree = await buildTree(tempDir, tempDir, MAX_DEPTH + 1);
    assert.deepEqual(tree, []);
  });

  it('should return empty array for non-existent directory', async () => {
    const tree = await buildTree('/nonexistent/path', '/nonexistent/path', 0);
    assert.deepEqual(tree, []);
  });
});

describe('IGNORED set', () => {
  it('should contain common ignored directories', () => {
    assert.ok(IGNORED.has('node_modules'));
    assert.ok(IGNORED.has('dist'));
    assert.ok(IGNORED.has('.git'));
    assert.ok(IGNORED.has('.DS_Store'));
  });
});
