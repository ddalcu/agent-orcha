import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from '../src/server.ts';
import { createMockOrchestrator } from './helpers/mock-orchestrator.ts';

describe('createServer', () => {
  it('should create a fastify server with health endpoint', async () => {
    const orchestrator = createMockOrchestrator({
      agents: { list: () => [] },
      triggers: { setManager: () => {} },
    });

    const server = await createServer(orchestrator);

    const res = await server.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.status, 'ok');
    assert.ok(body.timestamp);

    await server.close();
  });

  it('should register all route prefixes', async () => {
    const orchestrator = createMockOrchestrator({
      agents: { list: () => [] },
      triggers: { setManager: () => {} },
    });

    const server = await createServer(orchestrator);

    // Check agents route returns 200
    const agentsRes = await server.inject({ method: 'GET', url: '/api/agents' });
    assert.equal(agentsRes.statusCode, 200);

    // Check workflows route returns 200
    const workflowsRes = await server.inject({ method: 'GET', url: '/api/workflows' });
    assert.equal(workflowsRes.statusCode, 200);

    await server.close();
  });

  it('should decorate orchestrator on the instance', async () => {
    const orchestrator = createMockOrchestrator({
      agents: { list: () => [] },
      triggers: { setManager: () => {} },
    });

    const server = await createServer(orchestrator);
    assert.ok((server as any).orchestrator);

    await server.close();
  });
});
