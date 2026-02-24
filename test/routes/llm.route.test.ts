import { describe, it, before, afterEach, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createTestApp } from '../helpers/mock-fastify.ts';
import { llmRoutes } from '../../src/routes/llm.route.ts';
import { loadLLMConfig } from '../../lib/llm/llm-config.ts';
import { LLMFactory } from '../../lib/llm/llm-factory.ts';

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

  it('POST /:name/chat should return 200 on success', async () => {
    const mockCreate = mock.method(LLMFactory, 'create', () => ({
      invoke: async () => ({ content: 'Hello from LLM' }),
    }));

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
      payload: { message: 'Hi' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.output, 'Hello from LLM');
    assert.equal(body.model, 'default');
    mockCreate.mock.restore();
  });

  it('POST /:name/chat should return 429 on rate limit error', async () => {
    const rateLimitError = Object.assign(new Error('rate limit exceeded'), { status: 429 });
    const mockCreate = mock.method(LLMFactory, 'create', () => ({
      invoke: async () => { throw rateLimitError; },
    }));

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
      payload: { message: 'Hi' },
    });
    assert.equal(res.statusCode, 429);
    mockCreate.mock.restore();
  });

  it('POST /:name/chat should return 500 on generic error', async () => {
    const mockCreate = mock.method(LLMFactory, 'create', () => ({
      invoke: async () => { throw new Error('Something broke'); },
    }));

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
      payload: { message: 'Hi' },
    });
    assert.equal(res.statusCode, 500);
    const body = JSON.parse(res.payload);
    assert.ok(body.error.includes('Something broke'));
    mockCreate.mock.restore();
  });

  it('POST /:name/stream should stream SSE events on success', async () => {
    const chunks = [
      { content: 'Hello' },
      { content: ' World', usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
    ];
    const mockCreate = mock.method(LLMFactory, 'create', () => ({
      stream: async function* () {
        for (const chunk of chunks) yield chunk;
      },
    }));

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
      payload: { message: 'Hi' },
    });
    assert.equal(res.statusCode, 200);
    const payload = res.payload;
    // Should contain SSE data events
    assert.ok(payload.includes('data: {"content":"Hello"}'));
    assert.ok(payload.includes('data: {"content":" World"}'));
    // Should contain usage event
    assert.ok(payload.includes('"type":"usage"'));
    assert.ok(payload.includes('"input_tokens":10'));
    // Should end with [DONE]
    assert.ok(payload.includes('[DONE]'));
    mockCreate.mock.restore();
  });

  it('POST /:name/stream should handle errors during streaming', async () => {
    const mockCreate = mock.method(LLMFactory, 'create', () => ({
      stream: async function* () {
        yield { content: 'partial' };
        throw new Error('Stream failed');
      },
    }));

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
      payload: { message: 'Hi' },
    });
    const payload = res.payload;
    assert.ok(payload.includes('"error":"Stream failed"'));
    mockCreate.mock.restore();
  });
});
