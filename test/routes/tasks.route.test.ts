import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { createTestApp } from '../helpers/mock-fastify.ts';
import { tasksRoutes } from '../../src/routes/tasks.route.ts';

function mockTaskManager(overrides: Record<string, any> = {}) {
  return {
    listTasks: () => [],
    getTask: () => undefined,
    submitAgent: () => ({ id: 'task-1', kind: 'agent', status: 'working' }),
    submitWorkflow: () => ({ id: 'task-2', kind: 'workflow', status: 'working' }),
    cancelTask: () => undefined,
    respondToInput: () => undefined,
    track: () => ({ id: 'task-1' }),
    resolve: () => {},
    reject: () => {},
    registerAbort: () => {},
    unregisterAbort: () => {},
    ...overrides,
  };
}

describe('tasks.route', () => {
  let app: any;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('GET / should list tasks', async () => {
    const result = await createTestApp(tasksRoutes, '/api/tasks', {
      tasks: {
        getManager: () => mockTaskManager({
          listTasks: () => [
            { id: 't1', kind: 'agent', status: 'working' },
          ],
        }),
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/tasks' });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).length, 1);
  });

  it('GET /:id should return 404 for missing task', async () => {
    const result = await createTestApp(tasksRoutes, '/api/tasks', {
      tasks: { getManager: () => mockTaskManager() },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/tasks/missing' });
    assert.equal(res.statusCode, 404);
  });

  it('POST /agent should submit agent task', async () => {
    const result = await createTestApp(tasksRoutes, '/api/tasks', {
      agents: { get: () => ({ name: 'a1' }) },
      tasks: { getManager: () => mockTaskManager() },
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/agent',
      payload: { agent: 'a1', input: { query: 'hello' } },
    });
    assert.equal(res.statusCode, 202);
  });

  it('POST /agent should return 404 for missing agent', async () => {
    const result = await createTestApp(tasksRoutes, '/api/tasks', {
      tasks: { getManager: () => mockTaskManager() },
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/agent',
      payload: { agent: 'missing', input: {} },
    });
    assert.equal(res.statusCode, 404);
  });

  it('POST /workflow should submit workflow task', async () => {
    const result = await createTestApp(tasksRoutes, '/api/tasks', {
      workflows: { get: () => ({ name: 'w1' }) },
      tasks: { getManager: () => mockTaskManager() },
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/workflow',
      payload: { workflow: 'w1', input: { query: 'test' } },
    });
    assert.equal(res.statusCode, 202);
  });

  it('POST /:id/cancel should return 404 for missing task', async () => {
    const result = await createTestApp(tasksRoutes, '/api/tasks', {
      tasks: { getManager: () => mockTaskManager() },
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/missing/cancel',
    });
    assert.equal(res.statusCode, 404);
  });

  it('POST /:id/cancel should cancel task', async () => {
    const result = await createTestApp(tasksRoutes, '/api/tasks', {
      tasks: {
        getManager: () => mockTaskManager({
          getTask: (id: string) => id === 't1' ? { id: 't1', status: 'working' } : undefined,
          cancelTask: () => ({ id: 't1', status: 'canceled' }),
        }),
      },
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/t1/cancel',
    });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).status, 'canceled');
  });

  it('POST /:id/respond should return 400 without response', async () => {
    const result = await createTestApp(tasksRoutes, '/api/tasks', {
      tasks: { getManager: () => mockTaskManager() },
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/t1/respond',
      payload: {},
    });
    assert.equal(res.statusCode, 400);
  });

  it('GET /:id should return task when found', async () => {
    const result = await createTestApp(tasksRoutes, '/api/tasks', {
      tasks: {
        getManager: () => mockTaskManager({
          getTask: (id: string) => id === 't1' ? { id: 't1', kind: 'agent', status: 'working' } : undefined,
        }),
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/tasks/t1' });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).id, 't1');
  });

  it('POST /agent should return 400 without agent', async () => {
    const result = await createTestApp(tasksRoutes, '/api/tasks', {
      tasks: { getManager: () => mockTaskManager() },
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/agent',
      payload: { input: {} },
    });
    assert.equal(res.statusCode, 400);
  });

  it('POST /workflow should return 400 without workflow', async () => {
    const result = await createTestApp(tasksRoutes, '/api/tasks', {
      tasks: { getManager: () => mockTaskManager() },
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/workflow',
      payload: { input: {} },
    });
    assert.equal(res.statusCode, 400);
  });

  it('POST /workflow should return 404 for missing workflow', async () => {
    const result = await createTestApp(tasksRoutes, '/api/tasks', {
      tasks: { getManager: () => mockTaskManager() },
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/workflow',
      payload: { workflow: 'missing', input: {} },
    });
    assert.equal(res.statusCode, 404);
  });

  it('POST /:id/cancel should return 409 for non-cancelable task', async () => {
    const result = await createTestApp(tasksRoutes, '/api/tasks', {
      tasks: {
        getManager: () => mockTaskManager({
          getTask: (id: string) => id === 't1' ? { id: 't1', status: 'completed' } : undefined,
          cancelTask: () => undefined,
        }),
      },
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/t1/cancel',
    });
    assert.equal(res.statusCode, 409);
  });

  it('POST /:id/respond should return 404 for missing task', async () => {
    const result = await createTestApp(tasksRoutes, '/api/tasks', {
      tasks: { getManager: () => mockTaskManager() },
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/missing/respond',
      payload: { response: 'answer' },
    });
    assert.equal(res.statusCode, 404);
  });

  it('POST /:id/respond should return 409 for non-input-required task', async () => {
    const result = await createTestApp(tasksRoutes, '/api/tasks', {
      tasks: {
        getManager: () => mockTaskManager({
          getTask: (id: string) => id === 't1' ? { id: 't1', status: 'working' } : undefined,
          respondToInput: () => undefined,
        }),
      },
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/t1/respond',
      payload: { response: 'answer' },
    });
    assert.equal(res.statusCode, 409);
  });

  it('POST /:id/respond should succeed for input-required task', async () => {
    const result = await createTestApp(tasksRoutes, '/api/tasks', {
      tasks: {
        getManager: () => mockTaskManager({
          getTask: (id: string) => id === 't1' ? { id: 't1', status: 'input-required' } : undefined,
          respondToInput: () => ({ id: 't1', status: 'working' }),
        }),
      },
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/t1/respond',
      payload: { response: 'answer' },
    });
    assert.equal(res.statusCode, 202);
  });

  it('GET /:id/stream should return 404 for missing task', async () => {
    const result = await createTestApp(tasksRoutes, '/api/tasks', {
      tasks: { getManager: () => mockTaskManager() },
    });
    app = result.app;

    const res = await app.inject({
      method: 'GET',
      url: '/api/tasks/missing/stream',
    });
    assert.equal(res.statusCode, 404);
  });

  it('GET /:id/stream should set SSE headers for existing task', async () => {
    const result = await createTestApp(tasksRoutes, '/api/tasks', {
      tasks: {
        getManager: () => mockTaskManager({
          getTask: () => ({ id: 't1', status: 'completed', updatedAt: Date.now() }),
        }),
      },
    });
    app = result.app;

    const res = await app.inject({
      method: 'GET',
      url: '/api/tasks/t1/stream',
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type']?.includes('text/event-stream'));
  });
});
