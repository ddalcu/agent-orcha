import { describe, it, before, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createTestApp } from '../helpers/mock-fastify.ts';
import { llmRoutes } from '../../src/routes/llm.route.ts';
import { loadLLMConfig } from '../../lib/llm/llm-config.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, '..', 'fixtures', 'llm.json');

describe('llm.route', () => {
  let app: any;

  before(async () => {
    await loadLLMConfig(fixturePath);
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('GET / should list LLM configs', async () => {
    const result = await createTestApp(llmRoutes, '/api/llm');
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/llm' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.ok(Array.isArray(body));
    assert.ok(body.length > 0);
    assert.ok(body[0].name);
    assert.ok(body[0].model);
  });

  it('GET /:name should return specific config', async () => {
    const result = await createTestApp(llmRoutes, '/api/llm');
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/llm/default' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.name, 'default');
    assert.ok(body.model);
  });

  it('GET /:name should return 404 for non-existent', async () => {
    const result = await createTestApp(llmRoutes, '/api/llm');
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/llm/nonexistent' });
    assert.equal(res.statusCode, 404);
  });

  it('POST /:name/chat should return 400 for missing message', async () => {
    const result = await createTestApp(llmRoutes, '/api/llm', {
      tasks: {
        getManager: () => ({
          track: () => ({ id: 'task-1' }),
          resolve: () => {},
          reject: () => {},
        }),
      },
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/llm/default/chat',
      payload: {},
    });
    assert.equal(res.statusCode, 400);
  });

  it('POST /:name/stream should return 400 for missing message', async () => {
    const result = await createTestApp(llmRoutes, '/api/llm', {
      tasks: {
        getManager: () => ({
          track: () => ({ id: 'task-1' }),
          registerAbort: () => {},
          unregisterAbort: () => {},
          resolve: () => {},
          reject: () => {},
        }),
      },
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/llm/default/stream',
      payload: {},
    });
    assert.equal(res.statusCode, 400);
  });

  it('POST /:name/chat should return 400 for non-string message', async () => {
    const result = await createTestApp(llmRoutes, '/api/llm', {
      tasks: {
        getManager: () => ({
          track: () => ({ id: 'task-1' }),
          resolve: () => {},
          reject: () => {},
        }),
      },
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/llm/default/chat',
      payload: { message: 123 },
    });
    assert.equal(res.statusCode, 400);
  });

  it('POST /:name/stream should return 400 for non-string message', async () => {
    const result = await createTestApp(llmRoutes, '/api/llm', {
      tasks: {
        getManager: () => ({
          track: () => ({ id: 'task-1' }),
          registerAbort: () => {},
          unregisterAbort: () => {},
          resolve: () => {},
          reject: () => {},
        }),
      },
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/llm/default/stream',
      payload: { message: 123 },
    });
    assert.equal(res.statusCode, 400);
  });

  it('GET / should return baseUrl when configured', async () => {
    const result = await createTestApp(llmRoutes, '/api/llm');
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/llm' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    // Check that models with baseUrl have it in the response
    const localModel = body.find((m: any) => m.name === 'local');
    if (localModel) {
      assert.ok(localModel.baseUrl);
    }
    // Default should have null baseUrl
    const defaultModel = body.find((m: any) => m.name === 'default');
    assert.equal(defaultModel.baseUrl, null);
  });
});
