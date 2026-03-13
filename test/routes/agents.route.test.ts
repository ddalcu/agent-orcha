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

  it('POST /:name/stream should handle string chunks', async () => {
    async function* mockStream() {
      yield 'plain text chunk';
    }
    const result = await createTestApp(agentsRoutes, '/api/agents', {
      streamAgent: () => mockStream(),
      tasks: {
        getManager: () => ({
          track: () => ({ id: 'task-1' }),
          resolve: () => {},
          reject: () => {},
          addEvent: () => {},
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
    assert.ok(res.payload.includes('"content":"plain text chunk"'));
    assert.ok(res.payload.includes('[DONE]'));
  });

  it('POST /:name/stream should handle react_iteration events', async () => {
    const updatedMetrics: any[] = [];
    async function* mockStream() {
      yield { type: 'react_iteration', iteration: 1, maxIterations: 5 };
    }
    const result = await createTestApp(agentsRoutes, '/api/agents', {
      streamAgent: () => mockStream(),
      tasks: {
        getManager: () => ({
          track: () => ({ id: 'task-1' }),
          resolve: () => {},
          reject: () => {},
          addEvent: () => {},
          updateMetrics: (id: string, metrics: any) => { updatedMetrics.push(metrics); },
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
    assert.equal(updatedMetrics.length, 1);
    assert.equal(updatedMetrics[0].iteration, 1);
  });

  it('POST /:name/stream should handle tool_start and tool_end events', async () => {
    const storedEvents: any[] = [];
    async function* mockStream() {
      yield { type: 'content', content: 'thinking...' };
      yield { type: 'tool_start', tool: 'search', input: { q: 'test' } };
      yield { type: 'tool_end', tool: 'search', output: 'result data' };
    }
    const result = await createTestApp(agentsRoutes, '/api/agents', {
      streamAgent: () => mockStream(),
      tasks: {
        getManager: () => ({
          track: () => ({ id: 'task-1' }),
          resolve: () => {},
          reject: () => {},
          addEvent: (_id: string, evt: any) => { storedEvents.push(evt); },
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
    // Should have: content event (flushed before tool_start), tool_start, tool_end
    const toolEvents = storedEvents.filter((e) => e.type === 'tool_start' || e.type === 'tool_end');
    assert.equal(toolEvents.length, 2);
    assert.equal(toolEvents[0].tool, 'search');
    assert.deepEqual(toolEvents[0].input, { q: 'test' });
    assert.equal(toolEvents[1].output, 'result data');
  });

  it('POST /:name/stream should deduplicate identical thinking blocks', async () => {
    const storedEvents: any[] = [];
    async function* mockStream() {
      yield { type: 'thinking', content: 'same thought' };
      // Flush happens when type changes
      yield { type: 'content', content: 'reply' };
      // Second identical thinking block
      yield { type: 'thinking', content: 'same thought' };
      // Flush at end
    }
    const result = await createTestApp(agentsRoutes, '/api/agents', {
      streamAgent: () => mockStream(),
      tasks: {
        getManager: () => ({
          track: () => ({ id: 'task-1' }),
          resolve: () => {},
          reject: () => {},
          addEvent: (_id: string, evt: any) => { storedEvents.push(evt); },
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
    const thinkingEvents = storedEvents.filter((e) => e.type === 'thinking');
    // Second identical thinking block should be deduplicated
    assert.equal(thinkingEvents.length, 1);
  });

  it('POST /:name/stream should flush text on other event types', async () => {
    const storedEvents: any[] = [];
    async function* mockStream() {
      yield { type: 'content', content: 'some text' };
      yield { type: 'usage', tokens: 100 };
    }
    const result = await createTestApp(agentsRoutes, '/api/agents', {
      streamAgent: () => mockStream(),
      tasks: {
        getManager: () => ({
          track: () => ({ id: 'task-1' }),
          resolve: () => {},
          reject: () => {},
          addEvent: (_id: string, evt: any) => { storedEvents.push(evt); },
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
    // The content event should have been flushed when usage event arrived
    const contentEvents = storedEvents.filter((e) => e.type === 'content');
    assert.equal(contentEvents.length, 1);
    assert.equal(contentEvents[0].content, 'some text');
  });

  it('POST /:name/stream should handle errors gracefully', async () => {
    async function* mockStream() {
      yield { type: 'content', content: 'partial' };
      throw new Error('Stream failed');
    }
    const result = await createTestApp(agentsRoutes, '/api/agents', {
      streamAgent: () => mockStream(),
      tasks: {
        getManager: () => ({
          track: () => ({ id: 'task-1' }),
          resolve: () => {},
          reject: () => {},
          addEvent: () => {},
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
    assert.ok(res.payload.includes('"error":"Stream failed"'));
  });

  it('POST /:name/stream should handle tool_start with output for summarizeOutput', async () => {
    const storedEvents: any[] = [];
    async function* mockStream() {
      // Test summarizeOutput with array containing image parts
      yield {
        type: 'tool_end',
        tool: 'screenshot',
        output: [
          { type: 'image', mediaType: 'image/png', data: 'base64data' },
          { type: 'text', text: 'Caption' },
        ],
      };
      // Test summarizeOutput with a long string
      yield {
        type: 'tool_end',
        tool: 'search',
        output: 'x'.repeat(600),
      };
    }
    const result = await createTestApp(agentsRoutes, '/api/agents', {
      streamAgent: () => mockStream(),
      tasks: {
        getManager: () => ({
          track: () => ({ id: 'task-1' }),
          resolve: () => {},
          reject: () => {},
          addEvent: (_id: string, evt: any) => { storedEvents.push(evt); },
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
    // Image part should be summarized (no base64 data, just bytes count)
    const screenshotEvt = storedEvents.find((e) => e.tool === 'screenshot');
    assert.ok(screenshotEvt);
    assert.equal(screenshotEvt.output[0].type, 'image');
    assert.equal(screenshotEvt.output[0].bytes, 10); // 'base64data'.length
    assert.ok(!screenshotEvt.output[0].data); // data stripped
    // Text part preserved
    assert.equal(screenshotEvt.output[1].type, 'text');
    // Long string should be truncated
    const searchEvt = storedEvents.find((e) => e.tool === 'search');
    assert.ok(searchEvt);
    assert.ok(searchEvt.output.length <= 503); // 500 + '...'
    assert.ok(searchEvt.output.endsWith('...'));
  });

  it('GET /sessions/:sessionId/messages should return 404 for non-existent session', async () => {
    const result = await createTestApp(agentsRoutes, '/api/agents', {
      memory: {
        hasSession: () => false,
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/agents/sessions/s1/messages' });
    assert.equal(res.statusCode, 404);
    assert.equal(JSON.parse(res.payload).error, 'Session not found');
  });

  it('GET /sessions/:sessionId/messages should return message summaries for string content', async () => {
    const result = await createTestApp(agentsRoutes, '/api/agents', {
      memory: {
        hasSession: () => true,
        getStore: () => ({
          getMessages: () => [
            { role: 'user', content: 'Hello there' },
            { role: 'assistant', content: 'Hi! How can I help?', tool_calls: [{ name: 'search' }] },
          ],
        }),
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/agents/sessions/s1/messages' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.sessionId, 's1');
    assert.equal(body.messageCount, 2);
    assert.equal(body.messages[0].role, 'user');
    assert.equal(body.messages[0].textChars, 11); // 'Hello there'.length
    assert.equal(body.messages[0].images, 0);
    assert.equal(body.messages[1].role, 'assistant');
    assert.deepEqual(body.messages[1].toolCalls, ['search']);
  });

  it('GET /sessions/:sessionId/messages should handle multipart content with images', async () => {
    const result = await createTestApp(agentsRoutes, '/api/agents', {
      memory: {
        hasSession: () => true,
        getStore: () => ({
          getMessages: () => [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Look at this image' },
                { type: 'image', data: 'abc123', mediaType: 'image/png' },
              ],
            },
          ],
        }),
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/agents/sessions/s1/messages' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.messages[0].textChars, 18); // 'Look at this image'.length
    assert.equal(body.messages[0].images, 1);
    assert.equal(body.messages[0].imageBytes, 6); // 'abc123'.length
  });

  it('GET /sessions/:sessionId/messages should include tool result name', async () => {
    const result = await createTestApp(agentsRoutes, '/api/agents', {
      memory: {
        hasSession: () => true,
        getStore: () => ({
          getMessages: () => [
            { role: 'tool', content: 'result data', name: 'search_tool' },
          ],
        }),
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/agents/sessions/s1/messages' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.messages[0].name, 'search_tool');
  });

  it('GET / should resolve publish config for agents with publish: true', async () => {
    const result = await createTestApp(agentsRoutes, '/api/agents', {
      agents: {
        list: () => [{
          name: 'published-agent',
          description: 'A published agent',
          version: '1.0',
          tools: [],
          prompt: { inputVariables: [] },
          publish: true,
          sampleQuestions: ['What can you do?'],
        }],
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/agents' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body[0].publish.enabled, true);
    assert.equal(body[0].publish.hasPassword, false);
    assert.deepEqual(body[0].sampleQuestions, ['What can you do?']);
  });

  it('GET /:name should resolve publish config with password', async () => {
    const result = await createTestApp(agentsRoutes, '/api/agents', {
      agents: {
        get: (name: string) => name === 'a1' ? {
          name: 'a1',
          description: 'Agent 1',
          publish: { enabled: true, password: 'secret' },
        } : undefined,
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/agents/a1' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.publish.enabled, true);
    assert.equal(body.publish.hasPassword, true);
    // Password itself should not be exposed (replaced by hasPassword)
    assert.equal(body.publish.password, undefined);
  });
});
