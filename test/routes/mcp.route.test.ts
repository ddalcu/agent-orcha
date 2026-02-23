import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { createTestApp } from '../helpers/mock-fastify.ts';
import { mcpRoutes } from '../../src/routes/mcp.route.ts';

describe('mcp.route', () => {
  let app: any;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('GET / should list MCP servers', async () => {
    const result = await createTestApp(mcpRoutes, '/api/mcp', {
      mcp: {
        getManager: () => ({
          getServerNames: () => ['server1'],
          getServerConfig: () => ({ transport: 'stdio', command: 'npx' }),
        }),
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/mcp' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.length, 1);
    assert.equal(body[0].name, 'server1');
  });

  it('GET /:name should return 404 for missing server', async () => {
    const result = await createTestApp(mcpRoutes, '/api/mcp', {
      mcp: {
        getManager: () => ({
          getServerConfig: () => undefined,
        }),
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/mcp/missing' });
    assert.equal(res.statusCode, 404);
  });

  it('POST /:name/call should return 400 without tool name', async () => {
    const result = await createTestApp(mcpRoutes, '/api/mcp', {
      mcp: { getManager: () => ({}) },
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp/server1/call',
      payload: { arguments: {} },
    });
    assert.equal(res.statusCode, 400);
  });

  it('POST /:name/call should call tool on server', async () => {
    const result = await createTestApp(mcpRoutes, '/api/mcp', {
      mcp: {
        getManager: () => ({
          callTool: async () => 'tool result',
        }),
      },
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp/server1/call',
      payload: { tool: 'search', arguments: { query: 'test' } },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).content, 'tool result');
  });

  it('GET /:name should return server config', async () => {
    const result = await createTestApp(mcpRoutes, '/api/mcp', {
      mcp: {
        getManager: () => ({
          getServerConfig: (name: string) => name === 's1'
            ? { transport: 'stdio', command: 'npx', args: ['--arg'] }
            : undefined,
        }),
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/mcp/s1' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.name, 's1');
    assert.equal(body.transport, 'stdio');
  });

  it('GET /:name/tools should list server tools', async () => {
    const result = await createTestApp(mcpRoutes, '/api/mcp', {
      mcp: {
        getManager: () => ({
          getServerToolSchemas: async () => [{ name: 'tool1', description: 'A tool' }],
        }),
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/mcp/s1/tools' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.length, 1);
    assert.equal(body[0].name, 'tool1');
  });

  it('GET /:name/tools should return 500 on error', async () => {
    const result = await createTestApp(mcpRoutes, '/api/mcp', {
      mcp: {
        getManager: () => ({
          getServerToolSchemas: async () => { throw new Error('Connection failed'); },
        }),
      },
    });
    app = result.app;

    const res = await app.inject({ method: 'GET', url: '/api/mcp/s1/tools' });
    assert.equal(res.statusCode, 500);
  });

  it('POST /:name/call should return 400 without arguments', async () => {
    const result = await createTestApp(mcpRoutes, '/api/mcp', {
      mcp: { getManager: () => ({}) },
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp/s1/call',
      payload: { tool: 'search' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('POST /:name/call should return 500 on error', async () => {
    const result = await createTestApp(mcpRoutes, '/api/mcp', {
      mcp: {
        getManager: () => ({
          callTool: async () => { throw new Error('Tool failed'); },
        }),
      },
    });
    app = result.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp/s1/call',
      payload: { tool: 'search', arguments: { q: 'test' } },
    });
    assert.equal(res.statusCode, 500);
  });
});
