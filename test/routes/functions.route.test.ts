import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { createTestApp } from '../helpers/mock-fastify.ts';
import { functionsRoutes } from '../../src/routes/functions.route.ts';

describe('functions.route', () => {
  let app: any;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('GET / should list functions', async () => {
    const result = await createTestApp(functionsRoutes, '/api/functions', {
      functions: {
        list: () => [{
          name: 'greet',
          metadata: { description: 'Greeting function', version: '1.0', author: 'test', tags: ['util'] },
        }],
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/functions' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.length, 1);
    assert.equal(body[0].name, 'greet');
  });

  it('GET /:name should return 404 for missing function', async () => {
    const result = await createTestApp(functionsRoutes, '/api/functions', {
      functions: {
        get: () => undefined,
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/functions/missing' });
    assert.equal(res.statusCode, 404);
  });

  it('POST /:name/call should call function', async () => {
    const result = await createTestApp(functionsRoutes, '/api/functions', {
      functions: {
        getTool: (name: string) => name === 'greet'
          ? { invoke: async (args: any) => `Hello ${args.name}!` }
          : undefined,
      },
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/functions/greet/call',
      payload: { arguments: { name: 'World' } },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).content, 'Hello World!');
  });

  it('POST /:name/call should return 404 for missing function', async () => {
    const result = await createTestApp(functionsRoutes, '/api/functions', {
      functions: {
        getTool: () => undefined,
      },
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/functions/missing/call',
      payload: { arguments: { key: 'val' } },
    });
    assert.equal(res.statusCode, 404);
  });

  it('POST /:name/call should return 400 without arguments', async () => {
    const result = await createTestApp(functionsRoutes, '/api/functions');
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/functions/greet/call',
      payload: {},
    });
    assert.equal(res.statusCode, 400);
  });

  it('GET /:name should return function with schema', async () => {
    const { z } = await import('zod');
    const result = await createTestApp(functionsRoutes, '/api/functions', {
      functions: {
        get: (name: string) => name === 'greet' ? {
          name: 'greet',
          metadata: { description: 'Greeting', version: '1.0', author: 'test', tags: [] },
          tool: { schema: z.object({ name: z.string() }) },
        } : undefined,
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/functions/greet' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.name, 'greet');
    assert.ok(body.schema);
  });

  it('POST /:name/call should return 500 on error', async () => {
    const result = await createTestApp(functionsRoutes, '/api/functions', {
      functions: {
        getTool: () => ({
          invoke: async () => { throw new Error('Calc error'); },
        }),
      },
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/functions/calc/call',
      payload: { arguments: { a: 1 } },
    });
    assert.equal(res.statusCode, 500);
  });
});
