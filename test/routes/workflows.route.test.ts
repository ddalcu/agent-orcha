import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { createTestApp } from '../helpers/mock-fastify.ts';
import { workflowsRoutes } from '../../src/routes/workflows.route.ts';

describe('workflows.route', () => {
  let app: any;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('GET / should list workflows', async () => {
    const result = await createTestApp(workflowsRoutes, '/api/workflows', {
      workflows: {
        list: () => [{
          name: 'w1',
          description: 'Workflow 1',
          version: '1.0',
          type: 'steps',
          steps: [{ id: 's1' }],
          input: { schema: {} },
        }],
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/workflows' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.length, 1);
    assert.equal(body[0].name, 'w1');
  });

  it('GET /:name should return 404 for missing', async () => {
    const result = await createTestApp(workflowsRoutes, '/api/workflows');
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/workflows/missing' });
    assert.equal(res.statusCode, 404);
  });

  it('POST /:name/run should execute workflow', async () => {
    const result = await createTestApp(workflowsRoutes, '/api/workflows', {
      runWorkflow: async () => ({
        output: { result: 'done' },
        metadata: { duration: 10, stepsExecuted: 1, success: true },
        stepResults: {},
      }),
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
      url: '/api/workflows/w1/run',
      payload: { input: { query: 'test' } },
    });
    assert.equal(res.statusCode, 200);
  });

  it('POST /:name/run should return 404 for missing workflow', async () => {
    const result = await createTestApp(workflowsRoutes, '/api/workflows', {
      runWorkflow: async () => { throw new Error('Workflow "missing" not found'); },
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
      url: '/api/workflows/missing/run',
      payload: { input: {} },
    });
    assert.equal(res.statusCode, 404);
  });

  it('GET /:name should return workflow when found', async () => {
    const wf = { name: 'w1', description: 'WF', version: '1.0' };
    const result = await createTestApp(workflowsRoutes, '/api/workflows', {
      workflows: {
        get: (name: string) => name === 'w1' ? wf : undefined,
        list: () => [],
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/workflows/w1' });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).name, 'w1');
  });

  it('POST /:name/run should return 500 for generic error', async () => {
    const result = await createTestApp(workflowsRoutes, '/api/workflows', {
      runWorkflow: async () => { throw new Error('Internal error'); },
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
      url: '/api/workflows/w1/run',
      payload: { input: {} },
    });
    assert.equal(res.statusCode, 500);
  });

  it('POST /:name/stream should return SSE stream', async () => {
    async function* mockStream() {
      yield { type: 'step_complete', message: 'done' };
    }
    const result = await createTestApp(workflowsRoutes, '/api/workflows', {
      streamWorkflow: () => mockStream(),
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
      url: '/api/workflows/w1/stream',
      payload: { input: {} },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type']?.includes('text/event-stream'));
  });

  it('POST /:name/stream should handle error', async () => {
    const result = await createTestApp(workflowsRoutes, '/api/workflows', {
      streamWorkflow: () => { throw new Error('Stream error'); },
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
      url: '/api/workflows/w1/stream',
      payload: { input: {} },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.payload.includes('error'));
  });
});
