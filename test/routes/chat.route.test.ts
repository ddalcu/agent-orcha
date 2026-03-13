import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { createTestApp } from '../helpers/mock-fastify.ts';
import { chatRoutes } from '../../src/routes/chat.route.ts';

/**
 * Helper to create a mock agent with publish config.
 */
function makeAgent(overrides: Record<string, any> = {}) {
  return {
    name: overrides.name ?? 'test-agent',
    description: overrides.description ?? 'A test agent',
    prompt: { inputVariables: overrides.inputVariables ?? ['query'] },
    publish: overrides.publish ?? true,
    sampleQuestions: overrides.sampleQuestions ?? ['What is AI?'],
    ...overrides,
  };
}

/**
 * Helper to build orchestrator overrides with a specific agents map.
 */
function withAgents(agents: Record<string, any>, extra: Record<string, any> = {}) {
  const agentMap = new Map(Object.entries(agents));
  return {
    agents: {
      get: (name: string) => agentMap.get(name),
      list: () => Array.from(agentMap.values()),
      names: () => Array.from(agentMap.keys()),
      has: (name: string) => agentMap.has(name),
    },
    ...extra,
  };
}

describe('chat.route', () => {
  let app: any;

  afterEach(async () => {
    if (app) await app.close();
  });

  // ────────────────────────────────────────────
  // GET /chat/:agentName — serve chat HTML page
  // ────────────────────────────────────────────

  describe('GET /chat/:agentName', () => {
    it('should serve the chat HTML page for a published agent', async () => {
      const agent = makeAgent({ publish: true });
      const result = await createTestApp(chatRoutes, '', withAgents({ 'test-agent': agent }));
      app = result.app;

      const res = await app.inject({ method: 'GET', url: '/chat/test-agent' });
      assert.equal(res.statusCode, 200);
      assert.ok(res.headers['content-type']?.includes('text/html'));
      assert.ok(res.payload.length > 0);
    });

    it('should return 404 for a non-existent agent', async () => {
      const result = await createTestApp(chatRoutes, '', withAgents({}));
      app = result.app;

      const res = await app.inject({ method: 'GET', url: '/chat/no-agent' });
      assert.equal(res.statusCode, 404);
    });

    it('should return 404 for an agent with publish disabled', async () => {
      const agent = makeAgent({ publish: false });
      const result = await createTestApp(chatRoutes, '', withAgents({ 'test-agent': agent }));
      app = result.app;

      const res = await app.inject({ method: 'GET', url: '/chat/test-agent' });
      assert.equal(res.statusCode, 404);
    });

    it('should return 404 for an agent with publish: { enabled: false }', async () => {
      const agent = makeAgent({ publish: { enabled: false } });
      const result = await createTestApp(chatRoutes, '', withAgents({ 'test-agent': agent }));
      app = result.app;

      const res = await app.inject({ method: 'GET', url: '/chat/test-agent' });
      assert.equal(res.statusCode, 404);
    });

    it('should serve HTML for agent with publish: { enabled: true, password: "secret" }', async () => {
      const agent = makeAgent({ publish: { enabled: true, password: 'secret' } });
      const result = await createTestApp(chatRoutes, '', withAgents({ 'test-agent': agent }));
      app = result.app;

      const res = await app.inject({ method: 'GET', url: '/chat/test-agent' });
      assert.equal(res.statusCode, 200);
      assert.ok(res.headers['content-type']?.includes('text/html'));
    });

    it('should return 404 when publish is undefined', async () => {
      const agent = makeAgent({ publish: undefined });
      const result = await createTestApp(chatRoutes, '', withAgents({ 'test-agent': agent }));
      app = result.app;

      const res = await app.inject({ method: 'GET', url: '/chat/test-agent' });
      assert.equal(res.statusCode, 404);
    });
  });

  // ────────────────────────────────────────────
  // GET /api/chat/:agentName/config
  // ────────────────────────────────────────────

  describe('GET /api/chat/:agentName/config', () => {
    it('should return agent config for a published agent without password', async () => {
      const agent = makeAgent({
        name: 'my-agent',
        description: 'My agent',
        publish: true,
        sampleQuestions: ['Hello?'],
      });
      const result = await createTestApp(chatRoutes, '', withAgents({ 'my-agent': agent }));
      app = result.app;

      const res = await app.inject({ method: 'GET', url: '/api/chat/my-agent/config' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.name, 'my-agent');
      assert.equal(body.description, 'My agent');
      assert.deepEqual(body.inputVariables, ['query']);
      assert.equal(body.requiresPassword, false);
      assert.deepEqual(body.sampleQuestions, ['Hello?']);
    });

    it('should indicate requiresPassword for password-protected agent', async () => {
      const agent = makeAgent({ publish: { enabled: true, password: 'secret123' } });
      const result = await createTestApp(chatRoutes, '', withAgents({ 'test-agent': agent }));
      app = result.app;

      const res = await app.inject({ method: 'GET', url: '/api/chat/test-agent/config' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.equal(body.requiresPassword, true);
      // Password should NOT be exposed
      assert.equal(body.password, undefined);
    });

    it('should return 404 for non-existent agent', async () => {
      const result = await createTestApp(chatRoutes, '', withAgents({}));
      app = result.app;

      const res = await app.inject({ method: 'GET', url: '/api/chat/missing/config' });
      assert.equal(res.statusCode, 404);
      assert.deepEqual(JSON.parse(res.payload), { error: 'Agent not found' });
    });

    it('should return 404 for unpublished agent', async () => {
      const agent = makeAgent({ publish: false });
      const result = await createTestApp(chatRoutes, '', withAgents({ 'test-agent': agent }));
      app = result.app;

      const res = await app.inject({ method: 'GET', url: '/api/chat/test-agent/config' });
      assert.equal(res.statusCode, 404);
      assert.deepEqual(JSON.parse(res.payload), { error: 'Agent not found' });
    });
  });

  // ────────────────────────────────────────────
  // POST /api/chat/:agentName/auth
  // ────────────────────────────────────────────

  describe('POST /api/chat/:agentName/auth', () => {
    it('should return a token for correct password', async () => {
      const agent = makeAgent({ publish: { enabled: true, password: 'mypassword' } });
      const result = await createTestApp(chatRoutes, '', withAgents({ 'test-agent': agent }));
      app = result.app;

      const res = await app.inject({
        method: 'POST',
        url: '/api/chat/test-agent/auth',
        payload: { password: 'mypassword' },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok(body.token);
      assert.equal(typeof body.token, 'string');
      assert.ok(body.token.length > 0);
    });

    it('should return 401 for incorrect password', async () => {
      const agent = makeAgent({ publish: { enabled: true, password: 'mypassword' } });
      const result = await createTestApp(chatRoutes, '', withAgents({ 'test-agent': agent }));
      app = result.app;

      const res = await app.inject({
        method: 'POST',
        url: '/api/chat/test-agent/auth',
        payload: { password: 'wrongpassword' },
      });
      assert.equal(res.statusCode, 401);
      assert.deepEqual(JSON.parse(res.payload), { error: 'Invalid password' });
    });

    it('should return 401 when password is missing from body', async () => {
      const agent = makeAgent({ publish: { enabled: true, password: 'mypassword' } });
      const result = await createTestApp(chatRoutes, '', withAgents({ 'test-agent': agent }));
      app = result.app;

      const res = await app.inject({
        method: 'POST',
        url: '/api/chat/test-agent/auth',
        payload: {},
      });
      assert.equal(res.statusCode, 401);
      assert.deepEqual(JSON.parse(res.payload), { error: 'Password required' });
    });

    it('should return 401 when body is null/undefined', async () => {
      const agent = makeAgent({ publish: { enabled: true, password: 'mypassword' } });
      const result = await createTestApp(chatRoutes, '', withAgents({ 'test-agent': agent }));
      app = result.app;

      const res = await app.inject({
        method: 'POST',
        url: '/api/chat/test-agent/auth',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(null),
      });
      // Should handle gracefully (401 for missing password or body parse error)
      assert.ok([400, 401].includes(res.statusCode));
    });

    it('should return 400 when agent has no password configured', async () => {
      const agent = makeAgent({ publish: true });
      const result = await createTestApp(chatRoutes, '', withAgents({ 'test-agent': agent }));
      app = result.app;

      const res = await app.inject({
        method: 'POST',
        url: '/api/chat/test-agent/auth',
        payload: { password: 'anything' },
      });
      assert.equal(res.statusCode, 400);
      assert.deepEqual(JSON.parse(res.payload), { error: 'Agent does not require authentication' });
    });

    it('should return 404 for non-existent agent', async () => {
      const result = await createTestApp(chatRoutes, '', withAgents({}));
      app = result.app;

      const res = await app.inject({
        method: 'POST',
        url: '/api/chat/missing/auth',
        payload: { password: 'test' },
      });
      assert.equal(res.statusCode, 404);
    });

    it('should return 404 for unpublished agent', async () => {
      const agent = makeAgent({ publish: false });
      const result = await createTestApp(chatRoutes, '', withAgents({ 'test-agent': agent }));
      app = result.app;

      const res = await app.inject({
        method: 'POST',
        url: '/api/chat/test-agent/auth',
        payload: { password: 'test' },
      });
      assert.equal(res.statusCode, 404);
    });

    it('should return 401 for password length mismatch (timingSafeEqual catch)', async () => {
      // timingSafeEqual throws when buffer lengths differ — the catch block handles this
      const agent = makeAgent({ publish: { enabled: true, password: 'short' } });
      const result = await createTestApp(chatRoutes, '', withAgents({ 'test-agent': agent }));
      app = result.app;

      const res = await app.inject({
        method: 'POST',
        url: '/api/chat/test-agent/auth',
        payload: { password: 'a-much-longer-password-that-differs-in-length' },
      });
      assert.equal(res.statusCode, 401);
      assert.deepEqual(JSON.parse(res.payload), { error: 'Invalid password' });
    });

    it('should enforce rate limiting on repeated auth attempts', async () => {
      const agent = makeAgent({ publish: { enabled: true, password: 'secret' } });
      const result = await createTestApp(chatRoutes, '', withAgents({ 'test-agent': agent }));
      app = result.app;

      // Make 5 attempts (the limit), all should be 401
      for (let i = 0; i < 5; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/chat/test-agent/auth',
          payload: { password: 'wrong' },
        });
        assert.equal(res.statusCode, 401);
      }

      // 6th attempt should be rate-limited (429)
      const res = await app.inject({
        method: 'POST',
        url: '/api/chat/test-agent/auth',
        payload: { password: 'wrong' },
      });
      assert.equal(res.statusCode, 429);
      assert.ok(JSON.parse(res.payload).error.includes('Too many'));
    });
  });

  // ────────────────────────────────────────────
  // POST /api/chat/:agentName/stream
  // ────────────────────────────────────────────

  describe('POST /api/chat/:agentName/stream', () => {
    it('should stream responses for a published agent without password', async () => {
      const agent = makeAgent({ publish: true });
      async function* mockStream() {
        yield 'Hello';
        yield ' world';
      }
      const result = await createTestApp(chatRoutes, '', withAgents(
        { 'test-agent': agent },
        { streamAgent: () => mockStream() },
      ));
      app = result.app;

      const res = await app.inject({
        method: 'POST',
        url: '/api/chat/test-agent/stream',
        payload: { input: { query: 'hi' } },
      });
      assert.equal(res.statusCode, 200);
      assert.ok(res.headers['content-type']?.includes('text/event-stream'));
      assert.ok(res.payload.includes('data: {"content":"Hello"}'));
      assert.ok(res.payload.includes('data: {"content":" world"}'));
      assert.ok(res.payload.includes('data: [DONE]'));
    });

    it('should stream object chunks as-is', async () => {
      const agent = makeAgent({ publish: true });
      async function* mockStream() {
        yield { type: 'content', content: 'chunk1' };
        yield { type: 'metadata', info: 'extra' };
      }
      const result = await createTestApp(chatRoutes, '', withAgents(
        { 'test-agent': agent },
        { streamAgent: () => mockStream() },
      ));
      app = result.app;

      const res = await app.inject({
        method: 'POST',
        url: '/api/chat/test-agent/stream',
        payload: { input: { query: 'hi' } },
      });
      assert.equal(res.statusCode, 200);
      assert.ok(res.payload.includes('"type":"content"'));
      assert.ok(res.payload.includes('"type":"metadata"'));
    });

    it('should return 404 for non-existent agent', async () => {
      const result = await createTestApp(chatRoutes, '', withAgents({}));
      app = result.app;

      const res = await app.inject({
        method: 'POST',
        url: '/api/chat/missing/stream',
        payload: { input: { query: 'hi' } },
      });
      assert.equal(res.statusCode, 404);
    });

    it('should return 404 for unpublished agent', async () => {
      const agent = makeAgent({ publish: false });
      const result = await createTestApp(chatRoutes, '', withAgents(
        { 'test-agent': agent },
      ));
      app = result.app;

      const res = await app.inject({
        method: 'POST',
        url: '/api/chat/test-agent/stream',
        payload: { input: { query: 'hi' } },
      });
      assert.equal(res.statusCode, 404);
    });

    it('should return 401 for password-protected agent without token', async () => {
      const agent = makeAgent({ publish: { enabled: true, password: 'secret' } });
      const result = await createTestApp(chatRoutes, '', withAgents(
        { 'test-agent': agent },
      ));
      app = result.app;

      const res = await app.inject({
        method: 'POST',
        url: '/api/chat/test-agent/stream',
        payload: { input: { query: 'hi' } },
      });
      assert.equal(res.statusCode, 401);
      assert.deepEqual(JSON.parse(res.payload), { error: 'Unauthorized' });
    });

    it('should return 401 for password-protected agent with invalid token', async () => {
      const agent = makeAgent({ publish: { enabled: true, password: 'secret' } });
      const result = await createTestApp(chatRoutes, '', withAgents(
        { 'test-agent': agent },
      ));
      app = result.app;

      const res = await app.inject({
        method: 'POST',
        url: '/api/chat/test-agent/stream',
        headers: { 'x-chat-token': 'invalid-token-value' },
        payload: { input: { query: 'hi' } },
      });
      assert.equal(res.statusCode, 401);
    });

    it('should allow streaming with a valid auth token', async () => {
      const agent = makeAgent({ publish: { enabled: true, password: 'secret' } });
      async function* mockStream() {
        yield 'authenticated response';
      }
      const result = await createTestApp(chatRoutes, '', withAgents(
        { 'test-agent': agent },
        { streamAgent: () => mockStream() },
      ));
      app = result.app;

      // First authenticate to get a token
      const authRes = await app.inject({
        method: 'POST',
        url: '/api/chat/test-agent/auth',
        payload: { password: 'secret' },
      });
      assert.equal(authRes.statusCode, 200);
      const { token } = JSON.parse(authRes.payload);

      // Then stream with the token
      const res = await app.inject({
        method: 'POST',
        url: '/api/chat/test-agent/stream',
        headers: { 'x-chat-token': token },
        payload: { input: { query: 'hi' } },
      });
      assert.equal(res.statusCode, 200);
      assert.ok(res.payload.includes('authenticated response'));
      assert.ok(res.payload.includes('data: [DONE]'));
    });

    it('should reject token for a different agent', async () => {
      const agent1 = makeAgent({ name: 'agent-1', publish: { enabled: true, password: 'pass1' } });
      const agent2 = makeAgent({ name: 'agent-2', publish: { enabled: true, password: 'pass2' } });
      const result = await createTestApp(chatRoutes, '', withAgents(
        { 'agent-1': agent1, 'agent-2': agent2 },
      ));
      app = result.app;

      // Get token for agent-1
      const authRes = await app.inject({
        method: 'POST',
        url: '/api/chat/agent-1/auth',
        payload: { password: 'pass1' },
      });
      const { token } = JSON.parse(authRes.payload);

      // Try to use it for agent-2 — should fail
      const res = await app.inject({
        method: 'POST',
        url: '/api/chat/agent-2/stream',
        headers: { 'x-chat-token': token },
        payload: { input: { query: 'hi' } },
      });
      assert.equal(res.statusCode, 401);
    });

    it('should handle stream errors gracefully', async () => {
      const agent = makeAgent({ publish: true });
      async function* failingStream() {
        yield 'partial';
        throw new Error('Stream exploded');
      }
      const result = await createTestApp(chatRoutes, '', withAgents(
        { 'test-agent': agent },
        { streamAgent: () => failingStream() },
      ));
      app = result.app;

      const res = await app.inject({
        method: 'POST',
        url: '/api/chat/test-agent/stream',
        payload: { input: { query: 'hi' } },
      });
      assert.equal(res.statusCode, 200);
      assert.ok(res.payload.includes('"content":"partial"'));
      assert.ok(res.payload.includes('"error":"Stream exploded"'));
    });

    it('should handle non-Error throw in stream', async () => {
      const agent = makeAgent({ publish: true });
      async function* failingStream() {
        throw 'string error';
      }
      const result = await createTestApp(chatRoutes, '', withAgents(
        { 'test-agent': agent },
        { streamAgent: () => failingStream() },
      ));
      app = result.app;

      const res = await app.inject({
        method: 'POST',
        url: '/api/chat/test-agent/stream',
        payload: { input: { query: 'hi' } },
      });
      assert.equal(res.statusCode, 200);
      assert.ok(res.payload.includes('"error":"string error"'));
    });

    it('should pass sessionId to streamAgent', async () => {
      const agent = makeAgent({ publish: true });
      let capturedSessionId: string | undefined;
      async function* mockStream() {
        yield 'ok';
      }
      const result = await createTestApp(chatRoutes, '', withAgents(
        { 'test-agent': agent },
        {
          streamAgent: (_name: string, _input: any, sessionId?: string) => {
            capturedSessionId = sessionId;
            return mockStream();
          },
        },
      ));
      app = result.app;

      await app.inject({
        method: 'POST',
        url: '/api/chat/test-agent/stream',
        payload: { input: { query: 'hi' }, sessionId: 'session-123' },
      });
      assert.equal(capturedSessionId, 'session-123');
    });

    it('should pass input variables to streamAgent', async () => {
      const agent = makeAgent({ publish: true });
      let capturedInput: Record<string, unknown> | undefined;
      async function* mockStream() {
        yield 'ok';
      }
      const result = await createTestApp(chatRoutes, '', withAgents(
        { 'test-agent': agent },
        {
          streamAgent: (_name: string, input: any) => {
            capturedInput = input;
            return mockStream();
          },
        },
      ));
      app = result.app;

      await app.inject({
        method: 'POST',
        url: '/api/chat/test-agent/stream',
        payload: { input: { query: 'hello', context: 'world' } },
      });
      assert.deepEqual(capturedInput, { query: 'hello', context: 'world' });
    });
  });
});
