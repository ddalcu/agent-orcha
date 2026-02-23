import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { createTestApp } from '../helpers/mock-fastify.ts';
import { agentsRoutes } from '../../src/routes/agents.route.ts';

describe('agents.route', () => {
  let app: any;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('GET / should list agents', async () => {
    const result = await createTestApp(agentsRoutes, '/api/agents', {
      agents: {
        list: () => [{
          name: 'a1',
          description: 'Agent 1',
          version: '1.0',
          tools: [],
          prompt: { inputVariables: ['query'] },
        }],
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/agents' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.length, 1);
    assert.equal(body[0].name, 'a1');
  });

  it('GET /:name should return agent', async () => {
    const result = await createTestApp(agentsRoutes, '/api/agents', {
      agents: {
        get: (name: string) => name === 'a1' ? { name: 'a1', description: 'Agent 1' } : undefined,
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/agents/a1' });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).name, 'a1');
  });

  it('GET /:name should return 404 for non-existent', async () => {
    const result = await createTestApp(agentsRoutes, '/api/agents');
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/agents/missing' });
    assert.equal(res.statusCode, 404);
  });

  it('POST /:name/invoke should invoke agent', async () => {
    const result = await createTestApp(agentsRoutes, '/api/agents', {
      runAgent: async () => ({ output: 'result', metadata: { duration: 10 } }),
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
      url: '/api/agents/a1/invoke',
      payload: { input: { query: 'hello' } },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).output, 'result');
  });

  it('POST /:name/invoke should return 404 for missing agent', async () => {
    const result = await createTestApp(agentsRoutes, '/api/agents', {
      runAgent: async () => { throw new Error('Agent "missing" not found'); },
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
      url: '/api/agents/missing/invoke',
      payload: { input: {} },
    });
    assert.equal(res.statusCode, 404);
  });

  it('POST /:name/invoke should return 500 for errors', async () => {
    const result = await createTestApp(agentsRoutes, '/api/agents', {
      runAgent: async () => { throw new Error('Something went wrong'); },
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
      url: '/api/agents/a1/invoke',
      payload: { input: {} },
    });
    assert.equal(res.statusCode, 500);
  });

  it('GET /sessions/stats should return session count', async () => {
    const result = await createTestApp(agentsRoutes, '/api/agents', {
      memory: {
        getSessionCount: () => 5,
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/agents/sessions/stats' });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).totalSessions, 5);
  });

  it('GET /sessions/:sessionId should return 404 for non-existent', async () => {
    const result = await createTestApp(agentsRoutes, '/api/agents', {
      memory: {
        hasSession: () => false,
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/agents/sessions/s1' });
    assert.equal(res.statusCode, 404);
  });

  it('DELETE /sessions/:sessionId should clear session', async () => {
    let cleared = false;
    const result = await createTestApp(agentsRoutes, '/api/agents', {
      memory: {
        clearSession: () => { cleared = true; },
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'DELETE', url: '/api/agents/sessions/s1' });
    assert.equal(res.statusCode, 200);
    assert.ok(cleared);
  });

  it('GET /sessions/:sessionId should return session when it exists', async () => {
    const result = await createTestApp(agentsRoutes, '/api/agents', {
      memory: {
        hasSession: () => true,
        getMessageCount: () => 5,
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/agents/sessions/s1' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.sessionId, 's1');
    assert.equal(body.messageCount, 5);
  });

  it('POST /:name/stream should set SSE headers', async () => {
    async function* mockStream() {
      yield { type: 'content', content: 'hello' };
    }
    const result = await createTestApp(agentsRoutes, '/api/agents', {
      streamAgent: () => mockStream(),
      tasks: {
        getManager: () => ({
          track: () => ({ id: 'task-1' }),
          resolve: () => {},
          reject: () => {},
          registerAbort: () => {},
          unregisterAbort: () => {},
        }),
      },
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/agents/a1/stream',
      payload: { input: { query: 'hello' } },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type']?.includes('text/event-stream'));
  });
});
