import { describe, it, afterEach, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createTestApp } from '../helpers/mock-fastify.ts';
import { filesRoutes } from '../../src/routes/files.route.ts';

describe('files.route', () => {
  let app: any;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'files-route-'));
    await fs.writeFile(path.join(tempDir, 'test.txt'), 'hello');
  });

  afterEach(async () => {
    if (app) await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('GET /tree should return file tree', async () => {
    const result = await createTestApp(filesRoutes, '/api/files', {
      workspaceRoot: tempDir,
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/files/tree' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.ok(body.tree);
  });

  it('GET /read should read a file', async () => {
    const result = await createTestApp(filesRoutes, '/api/files', {
      workspaceRoot: tempDir,
    });
    app = result.app;

    const res = await app.inject({
      method: 'GET',
      url: '/api/files/read?path=test.txt',
    });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).content, 'hello');
  });

  it('GET /read should return 400 without path', async () => {
    const result = await createTestApp(filesRoutes, '/api/files', {
      workspaceRoot: tempDir,
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/files/read' });
    assert.equal(res.statusCode, 400);
  });

  it('GET /read should return 404 for missing file', async () => {
    const result = await createTestApp(filesRoutes, '/api/files', {
      workspaceRoot: tempDir,
    });
    app = result.app;

    const res = await app.inject({
      method: 'GET',
      url: '/api/files/read?path=missing.txt',
    });
    assert.equal(res.statusCode, 404);
  });

  it('PUT /write should update existing file', async () => {
    const result = await createTestApp(filesRoutes, '/api/files', {
      workspaceRoot: tempDir,
      reloadFile: async () => 'none',
    });
    app = result.app;

    const res = await app.inject({
      method: 'PUT',
      url: '/api/files/write',
      payload: { path: 'test.txt', content: 'updated' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).success, true);

    const content = await fs.readFile(path.join(tempDir, 'test.txt'), 'utf-8');
    assert.equal(content, 'updated');
  });

  it('PUT /write should return 404 for non-existent file', async () => {
    const result = await createTestApp(filesRoutes, '/api/files', {
      workspaceRoot: tempDir,
    });
    app = result.app;

    const res = await app.inject({
      method: 'PUT',
      url: '/api/files/write',
      payload: { path: 'new.txt', content: 'data' },
    });
    assert.equal(res.statusCode, 404);
  });

  it('POST /create should create a new file', async () => {
    const result = await createTestApp(filesRoutes, '/api/files', {
      workspaceRoot: tempDir,
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/files/create',
      payload: { path: 'new.txt', content: 'new content' },
    });
    assert.equal(res.statusCode, 200);

    const content = await fs.readFile(path.join(tempDir, 'new.txt'), 'utf-8');
    assert.equal(content, 'new content');
  });

  it('POST /create should return 409 if file exists', async () => {
    const result = await createTestApp(filesRoutes, '/api/files', {
      workspaceRoot: tempDir,
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/files/create',
      payload: { path: 'test.txt' },
    });
    assert.equal(res.statusCode, 409);
  });

  it('GET /template should return template', async () => {
    const result = await createTestApp(filesRoutes, '/api/files', {
      workspaceRoot: tempDir,
    });
    app = result.app;

    const res = await app.inject({
      method: 'GET',
      url: '/api/files/template?type=agent&name=my-agent',
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.ok(body.path);
    assert.ok(body.content);
  });

  it('GET /template should return 400 without type/name', async () => {
    const result = await createTestApp(filesRoutes, '/api/files', {
      workspaceRoot: tempDir,
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/files/template' });
    assert.equal(res.statusCode, 400);
  });

  it('DELETE /delete should delete a file', async () => {
    const result = await createTestApp(filesRoutes, '/api/files', {
      workspaceRoot: tempDir,
    });
    app = result.app;

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/files/delete',
      payload: { path: 'test.txt' },
    });
    assert.equal(res.statusCode, 200);
  });

  it('PUT /write should return 400 without path', async () => {
    const result = await createTestApp(filesRoutes, '/api/files', {
      workspaceRoot: tempDir,
    });
    app = result.app;

    const res = await app.inject({
      method: 'PUT',
      url: '/api/files/write',
      payload: { content: 'data' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('POST /create should return 400 without path', async () => {
    const result = await createTestApp(filesRoutes, '/api/files', {
      workspaceRoot: tempDir,
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/files/create',
      payload: {},
    });
    assert.equal(res.statusCode, 400);
  });

  it('POST /rename should rename a file', async () => {
    const result = await createTestApp(filesRoutes, '/api/files', {
      workspaceRoot: tempDir,
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/files/rename',
      payload: { oldPath: 'test.txt', newPath: 'renamed.txt' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).success, true);
  });

  it('POST /rename should return 400 without paths', async () => {
    const result = await createTestApp(filesRoutes, '/api/files', {
      workspaceRoot: tempDir,
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/files/rename',
      payload: {},
    });
    assert.equal(res.statusCode, 400);
  });

  it('POST /rename should return 404 for missing source', async () => {
    const result = await createTestApp(filesRoutes, '/api/files', {
      workspaceRoot: tempDir,
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/files/rename',
      payload: { oldPath: 'missing.txt', newPath: 'new.txt' },
    });
    assert.equal(res.statusCode, 404);
  });

  it('POST /rename should return 409 if target exists', async () => {
    await fs.writeFile(path.join(tempDir, 'other.txt'), 'other');
    const result = await createTestApp(filesRoutes, '/api/files', {
      workspaceRoot: tempDir,
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/files/rename',
      payload: { oldPath: 'test.txt', newPath: 'other.txt' },
    });
    assert.equal(res.statusCode, 409);
  });

  it('DELETE /delete should return 400 without path', async () => {
    const result = await createTestApp(filesRoutes, '/api/files', {
      workspaceRoot: tempDir,
    });
    app = result.app;

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/files/delete',
      payload: {},
    });
    assert.equal(res.statusCode, 400);
  });

  it('DELETE /delete should return 404 for missing file', async () => {
    const result = await createTestApp(filesRoutes, '/api/files', {
      workspaceRoot: tempDir,
    });
    app = result.app;

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/files/delete',
      payload: { path: 'missing.txt' },
    });
    assert.equal(res.statusCode, 404);
  });

  it('GET /template should return 400 for unknown type', async () => {
    const result = await createTestApp(filesRoutes, '/api/files', {
      workspaceRoot: tempDir,
    });
    app = result.app;

    const res = await app.inject({
      method: 'GET',
      url: '/api/files/template?type=unknown&name=test',
    });
    assert.equal(res.statusCode, 400);
  });

  it('POST /create should create file in existing subdirectory', async () => {
    await fs.mkdir(path.join(tempDir, 'subdir'));
    const result = await createTestApp(filesRoutes, '/api/files', {
      workspaceRoot: tempDir,
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/files/create',
      payload: { path: 'subdir/nested.txt', content: 'nested' },
    });
    assert.equal(res.statusCode, 200);

    const content = await fs.readFile(path.join(tempDir, 'subdir', 'nested.txt'), 'utf-8');
    assert.equal(content, 'nested');
  });

  it('POST /rename should return 400 for renaming a directory', async () => {
    await fs.mkdir(path.join(tempDir, 'mydir'));
    const result = await createTestApp(filesRoutes, '/api/files', {
      workspaceRoot: tempDir,
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/files/rename',
      payload: { oldPath: 'mydir', newPath: 'mydir2' },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(JSON.parse(res.payload).error.includes('directory'));
  });

  it('DELETE /delete should delete a file', async () => {
    await fs.writeFile(path.join(tempDir, 'to-delete.txt'), 'bye');
    const result = await createTestApp(filesRoutes, '/api/files', {
      workspaceRoot: tempDir,
    });
    app = result.app;

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/files/delete',
      payload: { path: 'to-delete.txt' },
    });
    assert.equal(res.statusCode, 200);
  });

  it('DELETE /delete should delete a directory', async () => {
    await fs.mkdir(path.join(tempDir, 'dir-to-delete'));
    await fs.writeFile(path.join(tempDir, 'dir-to-delete', 'file.txt'), 'content');
    const result = await createTestApp(filesRoutes, '/api/files', {
      workspaceRoot: tempDir,
    });
    app = result.app;

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/files/delete',
      payload: { path: 'dir-to-delete' },
    });
    assert.equal(res.statusCode, 200);
  });
});
