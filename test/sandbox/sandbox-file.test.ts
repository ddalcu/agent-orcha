import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createFileTools } from '../../lib/sandbox/sandbox-file.ts';
import type { SandboxConfig } from '../../lib/sandbox/types.ts';
import type { StructuredTool } from '../../lib/types/llm-types.ts';

function createConfig(overrides?: Partial<SandboxConfig>): SandboxConfig {
  return {
    enabled: true,
    commandTimeout: 30_000,
    maxOutputChars: 50_000,
    ...overrides,
  };
}

const TEST_DIR = '/tmp/sandbox-file-test-' + process.pid;

function getToolByName(tools: StructuredTool[], name: string): StructuredTool {
  const t = tools.find(t => t.name === name);
  if (!t) throw new Error(`Tool ${name} not found`);
  return t;
}

describe('createFileTools', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('should return 5 tools', () => {
    const tools = createFileTools(createConfig());
    assert.equal(tools.length, 5);
    const names = tools.map(t => t.name);
    assert.ok(names.includes('sandbox_file_read'));
    assert.ok(names.includes('sandbox_file_write'));
    assert.ok(names.includes('sandbox_file_edit'));
    assert.ok(names.includes('sandbox_file_insert'));
    assert.ok(names.includes('sandbox_file_replace_lines'));
  });

  describe('sandbox_file_read', () => {
    it('should read a file and return numbered lines', async () => {
      const filePath = join(TEST_DIR, 'read-test.txt');
      writeFileSync(filePath, 'line1\nline2\nline3', 'utf-8');

      const tools = createFileTools(createConfig());
      const readTool = getToolByName(tools, 'sandbox_file_read');
      const result = JSON.parse(await readTool.invoke({ path: filePath }) as string);

      assert.equal(result.lines, 3);
      assert.equal(result.size, 17);
      assert.ok(result.content.includes('1\tline1'));
      assert.ok(result.content.includes('2\tline2'));
      assert.ok(result.content.includes('3\tline3'));
      assert.equal(result.truncated, undefined);
    });

    it('should truncate content when exceeding maxOutputChars', async () => {
      const filePath = join(TEST_DIR, 'long-file.txt');
      const longContent = 'x'.repeat(200);
      writeFileSync(filePath, longContent, 'utf-8');

      const tools = createFileTools(createConfig({ maxOutputChars: 50 }));
      const readTool = getToolByName(tools, 'sandbox_file_read');
      const result = JSON.parse(await readTool.invoke({ path: filePath }) as string);

      assert.equal(result.truncated, true);
      assert.ok(result.content.length <= 50);
    });

    it('should not set truncated flag for small files', async () => {
      const filePath = join(TEST_DIR, 'small.txt');
      writeFileSync(filePath, 'hi', 'utf-8');

      const tools = createFileTools(createConfig());
      const readTool = getToolByName(tools, 'sandbox_file_read');
      const result = JSON.parse(await readTool.invoke({ path: filePath }) as string);

      assert.equal(result.truncated, undefined);
    });

    it('should return error for non-existent file', async () => {
      const tools = createFileTools(createConfig());
      const readTool = getToolByName(tools, 'sandbox_file_read');
      const result = JSON.parse(await readTool.invoke({ path: join(TEST_DIR, 'nope.txt') }) as string);

      assert.ok(result.error);
    });

    it('should reject paths outside /tmp', async () => {
      const tools = createFileTools(createConfig());
      const readTool = getToolByName(tools, 'sandbox_file_read');
      const result = JSON.parse(await readTool.invoke({ path: '/etc/passwd' }) as string);

      assert.ok(result.error);
      assert.ok(result.error.includes('Path must be under'));
    });

    it('should reject path traversal attempts', async () => {
      const tools = createFileTools(createConfig());
      const readTool = getToolByName(tools, 'sandbox_file_read');
      const result = JSON.parse(await readTool.invoke({ path: '/tmp/../../etc/passwd' }) as string);

      assert.ok(result.error);
      assert.ok(result.error.includes('Path must be under'));
    });
  });

  describe('sandbox_file_write', () => {
    it('should create a new file', async () => {
      const filePath = join(TEST_DIR, 'new-file.txt');
      const tools = createFileTools(createConfig());
      const writeTool = getToolByName(tools, 'sandbox_file_write');

      const result = JSON.parse(await writeTool.invoke({ path: filePath, content: 'hello world' }) as string);

      assert.equal(result.path, filePath);
      assert.equal(result.size, 11);
      assert.equal(result.created, true);
    });

    it('should overwrite an existing file and report created=false', async () => {
      const filePath = join(TEST_DIR, 'existing.txt');
      writeFileSync(filePath, 'old content', 'utf-8');

      const tools = createFileTools(createConfig());
      const writeTool = getToolByName(tools, 'sandbox_file_write');
      const result = JSON.parse(await writeTool.invoke({ path: filePath, content: 'new content' }) as string);

      assert.equal(result.created, false);
      assert.equal(result.size, 11);
    });

    it('should create parent directories automatically', async () => {
      const filePath = join(TEST_DIR, 'a', 'b', 'c', 'deep.txt');
      const tools = createFileTools(createConfig());
      const writeTool = getToolByName(tools, 'sandbox_file_write');

      const result = JSON.parse(await writeTool.invoke({ path: filePath, content: 'deep' }) as string);

      assert.equal(result.created, true);
      assert.ok(existsSync(filePath));
    });

    it('should reject paths outside /tmp', async () => {
      const tools = createFileTools(createConfig());
      const writeTool = getToolByName(tools, 'sandbox_file_write');
      const result = JSON.parse(await writeTool.invoke({ path: '/home/test.txt', content: 'nope' }) as string);

      assert.ok(result.error);
      assert.ok(result.error.includes('Path must be under'));
    });
  });

  describe('sandbox_file_edit', () => {
    it('should replace a unique occurrence', async () => {
      const filePath = join(TEST_DIR, 'edit-test.txt');
      writeFileSync(filePath, 'hello world foo bar', 'utf-8');

      const tools = createFileTools(createConfig());
      const editTool = getToolByName(tools, 'sandbox_file_edit');
      const result = JSON.parse(await editTool.invoke({
        path: filePath,
        old_string: 'world',
        new_string: 'universe',
      }) as string);

      assert.equal(result.replacements, 1);
      assert.equal(result.path, filePath);
    });

    it('should return error when old_string not found', async () => {
      const filePath = join(TEST_DIR, 'edit-nf.txt');
      writeFileSync(filePath, 'hello world', 'utf-8');

      const tools = createFileTools(createConfig());
      const editTool = getToolByName(tools, 'sandbox_file_edit');
      const result = JSON.parse(await editTool.invoke({
        path: filePath,
        old_string: 'xyz',
        new_string: 'abc',
      }) as string);

      assert.ok(result.error);
      assert.ok(result.error.includes('not found'));
    });

    it('should return error when old_string appears multiple times', async () => {
      const filePath = join(TEST_DIR, 'edit-multi.txt');
      writeFileSync(filePath, 'foo bar foo baz foo', 'utf-8');

      const tools = createFileTools(createConfig());
      const editTool = getToolByName(tools, 'sandbox_file_edit');
      const result = JSON.parse(await editTool.invoke({
        path: filePath,
        old_string: 'foo',
        new_string: 'qux',
      }) as string);

      assert.ok(result.error);
      assert.ok(result.error.includes('3 times'));
      assert.ok(result.error.includes('must be unique'));
    });

    it('should return error for non-existent file', async () => {
      const tools = createFileTools(createConfig());
      const editTool = getToolByName(tools, 'sandbox_file_edit');
      const result = JSON.parse(await editTool.invoke({
        path: join(TEST_DIR, 'missing.txt'),
        old_string: 'a',
        new_string: 'b',
      }) as string);

      assert.ok(result.error);
    });

    it('should reject paths outside /tmp', async () => {
      const tools = createFileTools(createConfig());
      const editTool = getToolByName(tools, 'sandbox_file_edit');
      const result = JSON.parse(await editTool.invoke({
        path: '/etc/hosts',
        old_string: 'a',
        new_string: 'b',
      }) as string);

      assert.ok(result.error);
      assert.ok(result.error.includes('Path must be under'));
    });
  });

  describe('sandbox_file_insert', () => {
    it('should insert content after a line', async () => {
      const filePath = join(TEST_DIR, 'insert-test.txt');
      writeFileSync(filePath, 'line1\nline2\nline3', 'utf-8');

      const tools = createFileTools(createConfig());
      const insertTool = getToolByName(tools, 'sandbox_file_insert');
      const result = JSON.parse(await insertTool.invoke({
        path: filePath,
        line: 2,
        content: 'inserted',
        position: 'after',
      }) as string);

      assert.equal(result.insertedLines, 1);
      assert.equal(result.atLine, 3);
      assert.equal(result.path, filePath);
    });

    it('should insert content before a line', async () => {
      const filePath = join(TEST_DIR, 'insert-before.txt');
      writeFileSync(filePath, 'line1\nline2\nline3', 'utf-8');

      const tools = createFileTools(createConfig());
      const insertTool = getToolByName(tools, 'sandbox_file_insert');
      const result = JSON.parse(await insertTool.invoke({
        path: filePath,
        line: 1,
        content: 'before-first',
        position: 'before',
      }) as string);

      assert.equal(result.insertedLines, 1);
      assert.equal(result.atLine, 1);
    });

    it('should insert multiple lines', async () => {
      const filePath = join(TEST_DIR, 'insert-multi.txt');
      writeFileSync(filePath, 'line1\nline2', 'utf-8');

      const tools = createFileTools(createConfig());
      const insertTool = getToolByName(tools, 'sandbox_file_insert');
      const result = JSON.parse(await insertTool.invoke({
        path: filePath,
        line: 1,
        content: 'new1\nnew2\nnew3',
        position: 'after',
      }) as string);

      assert.equal(result.insertedLines, 3);
    });

    it('should return error for line number out of range (too high)', async () => {
      const filePath = join(TEST_DIR, 'insert-range.txt');
      writeFileSync(filePath, 'line1\nline2', 'utf-8');

      const tools = createFileTools(createConfig());
      const insertTool = getToolByName(tools, 'sandbox_file_insert');
      const result = JSON.parse(await insertTool.invoke({
        path: filePath,
        line: 5,
        content: 'nope',
        position: 'after',
      }) as string);

      assert.ok(result.error);
      assert.ok(result.error.includes('out of range'));
    });

    it('should reject line number less than 1 via schema validation', async () => {
      const filePath = join(TEST_DIR, 'insert-zero.txt');
      writeFileSync(filePath, 'line1\nline2', 'utf-8');

      const tools = createFileTools(createConfig());
      const insertTool = getToolByName(tools, 'sandbox_file_insert');
      await assert.rejects(
        () => insertTool.invoke({ path: filePath, line: 0, content: 'nope', position: 'before' }),
        (err: Error) => err.message.includes('Invalid args'),
      );
    });

    it('should return error for non-existent file', async () => {
      const tools = createFileTools(createConfig());
      const insertTool = getToolByName(tools, 'sandbox_file_insert');
      const result = JSON.parse(await insertTool.invoke({
        path: join(TEST_DIR, 'missing.txt'),
        line: 1,
        content: 'nope',
        position: 'after',
      }) as string);

      assert.ok(result.error);
    });

    it('should reject paths outside /tmp', async () => {
      const tools = createFileTools(createConfig());
      const insertTool = getToolByName(tools, 'sandbox_file_insert');
      const result = JSON.parse(await insertTool.invoke({
        path: '/etc/hosts',
        line: 1,
        content: 'nope',
        position: 'after',
      }) as string);

      assert.ok(result.error);
      assert.ok(result.error.includes('Path must be under'));
    });
  });

  describe('sandbox_file_replace_lines', () => {
    it('should replace a range of lines', async () => {
      const filePath = join(TEST_DIR, 'replace-test.txt');
      writeFileSync(filePath, 'line1\nline2\nline3\nline4', 'utf-8');

      const tools = createFileTools(createConfig());
      const replaceTool = getToolByName(tools, 'sandbox_file_replace_lines');
      const result = JSON.parse(await replaceTool.invoke({
        path: filePath,
        start_line: 2,
        end_line: 3,
        content: 'replaced',
      }) as string);

      assert.equal(result.removedLines, 2);
      assert.equal(result.insertedLines, 1);
      assert.equal(result.path, filePath);
    });

    it('should replace a single line', async () => {
      const filePath = join(TEST_DIR, 'replace-single.txt');
      writeFileSync(filePath, 'line1\nline2\nline3', 'utf-8');

      const tools = createFileTools(createConfig());
      const replaceTool = getToolByName(tools, 'sandbox_file_replace_lines');
      const result = JSON.parse(await replaceTool.invoke({
        path: filePath,
        start_line: 2,
        end_line: 2,
        content: 'new-line2',
      }) as string);

      assert.equal(result.removedLines, 1);
      assert.equal(result.insertedLines, 1);
    });

    it('should replace with more lines than removed', async () => {
      const filePath = join(TEST_DIR, 'replace-expand.txt');
      writeFileSync(filePath, 'line1\nline2\nline3', 'utf-8');

      const tools = createFileTools(createConfig());
      const replaceTool = getToolByName(tools, 'sandbox_file_replace_lines');
      const result = JSON.parse(await replaceTool.invoke({
        path: filePath,
        start_line: 1,
        end_line: 1,
        content: 'new1\nnew2\nnew3',
      }) as string);

      assert.equal(result.removedLines, 1);
      assert.equal(result.insertedLines, 3);
    });

    it('should return error when start_line is out of range', async () => {
      const filePath = join(TEST_DIR, 'replace-bad-start.txt');
      writeFileSync(filePath, 'line1\nline2', 'utf-8');

      const tools = createFileTools(createConfig());
      const replaceTool = getToolByName(tools, 'sandbox_file_replace_lines');
      const result = JSON.parse(await replaceTool.invoke({
        path: filePath,
        start_line: 5,
        end_line: 6,
        content: 'nope',
      }) as string);

      assert.ok(result.error);
      assert.ok(result.error.includes('start_line'));
      assert.ok(result.error.includes('out of range'));
    });

    it('should reject start_line less than 1 via schema validation', async () => {
      const filePath = join(TEST_DIR, 'replace-zero-start.txt');
      writeFileSync(filePath, 'line1\nline2', 'utf-8');

      const tools = createFileTools(createConfig());
      const replaceTool = getToolByName(tools, 'sandbox_file_replace_lines');
      await assert.rejects(
        () => replaceTool.invoke({ path: filePath, start_line: 0, end_line: 1, content: 'nope' }),
        (err: Error) => err.message.includes('Invalid args'),
      );
    });

    it('should return error when end_line is less than start_line', async () => {
      const filePath = join(TEST_DIR, 'replace-bad-end.txt');
      writeFileSync(filePath, 'line1\nline2\nline3', 'utf-8');

      const tools = createFileTools(createConfig());
      const replaceTool = getToolByName(tools, 'sandbox_file_replace_lines');
      const result = JSON.parse(await replaceTool.invoke({
        path: filePath,
        start_line: 3,
        end_line: 2,
        content: 'nope',
      }) as string);

      assert.ok(result.error);
      assert.ok(result.error.includes('end_line'));
    });

    it('should return error when end_line exceeds file length', async () => {
      const filePath = join(TEST_DIR, 'replace-end-over.txt');
      writeFileSync(filePath, 'line1\nline2', 'utf-8');

      const tools = createFileTools(createConfig());
      const replaceTool = getToolByName(tools, 'sandbox_file_replace_lines');
      const result = JSON.parse(await replaceTool.invoke({
        path: filePath,
        start_line: 1,
        end_line: 10,
        content: 'nope',
      }) as string);

      assert.ok(result.error);
      assert.ok(result.error.includes('end_line'));
    });

    it('should return error for non-existent file', async () => {
      const tools = createFileTools(createConfig());
      const replaceTool = getToolByName(tools, 'sandbox_file_replace_lines');
      const result = JSON.parse(await replaceTool.invoke({
        path: join(TEST_DIR, 'missing.txt'),
        start_line: 1,
        end_line: 1,
        content: 'nope',
      }) as string);

      assert.ok(result.error);
    });

    it('should reject paths outside /tmp', async () => {
      const tools = createFileTools(createConfig());
      const replaceTool = getToolByName(tools, 'sandbox_file_replace_lines');
      const result = JSON.parse(await replaceTool.invoke({
        path: '/etc/hosts',
        start_line: 1,
        end_line: 1,
        content: 'nope',
      }) as string);

      assert.ok(result.error);
      assert.ok(result.error.includes('Path must be under'));
    });
  });

  describe('symlink escape prevention', () => {
    it('should reject symlinks that point outside /tmp', async () => {
      const symlinkPath = join(TEST_DIR, 'escape-link');
      try {
        symlinkSync('/etc', symlinkPath);
      } catch {
        // Skip if we cannot create symlinks (permissions)
        return;
      }

      const tools = createFileTools(createConfig());
      const readTool = getToolByName(tools, 'sandbox_file_read');
      const result = JSON.parse(await readTool.invoke({ path: join(symlinkPath, 'hosts') }) as string);

      assert.ok(result.error);
      assert.ok(result.error.includes('Symlink escapes') || result.error.includes('Path must be under'));
    });
  });

  describe('relative path resolution', () => {
    it('should resolve relative paths under /tmp', async () => {
      const fileName = `rel-test-${process.pid}.txt`;
      const fullPath = join('/tmp', fileName);
      writeFileSync(fullPath, 'relative content', 'utf-8');

      try {
        const tools = createFileTools(createConfig());
        const readTool = getToolByName(tools, 'sandbox_file_read');
        // Pass just the filename — validatePath should resolve it under /tmp
        const result = JSON.parse(await readTool.invoke({ path: `/tmp/${fileName}` }) as string);

        assert.ok(result.content);
        assert.ok(result.content.includes('relative content'));
      } finally {
        rmSync(fullPath, { force: true });
      }
    });
  });
});
