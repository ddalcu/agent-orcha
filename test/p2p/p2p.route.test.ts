import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createTestApp } from '../helpers/mock-fastify.ts';
import { p2pRoutes } from '../../src/routes/p2p.route.ts';

describe('P2P Routes', () => {
  describe('GET /api/p2p/status', () => {
    it('should return disabled status when P2PManager is not set', async () => {
      const { app } = await createTestApp(p2pRoutes, '/api/p2p');

      const res = await app.inject({ method: 'GET', url: '/api/p2p/status' });
      assert.equal(res.statusCode, 200);

      const body = JSON.parse(res.payload);
      assert.equal(body.enabled, false);
      assert.equal(body.connected, false);
      assert.equal(body.peerCount, 0);
    });

    it('should return enabled status when P2PManager is present', async () => {
      const { app } = await createTestApp(p2pRoutes, '/api/p2p', {
        _p2pManager: {
          getStatus: () => ({ enabled: true, connected: true, peerCount: 2, peerName: 'my-peer' }),
        },
      });

      const res = await app.inject({ method: 'GET', url: '/api/p2p/status' });
      assert.equal(res.statusCode, 200);

      const body = JSON.parse(res.payload);
      assert.equal(body.enabled, true);
      assert.equal(body.connected, true);
      assert.equal(body.peerCount, 2);
      assert.equal(body.peerName, 'my-peer');
    });
  });

  describe('GET /api/p2p/peers', () => {
    it('should return empty array when P2PManager is not set', async () => {
      const { app } = await createTestApp(p2pRoutes, '/api/p2p');

      const res = await app.inject({ method: 'GET', url: '/api/p2p/peers' });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(JSON.parse(res.payload), []);
    });

    it('should return peers from manager', async () => {
      const peers = [
        { peerId: 'abc', peerName: 'Node1', version: '1.0.0', agents: [], connectedAt: 1000 },
        { peerId: 'def', peerName: 'Node2', version: '1.0.0', agents: [{ name: 'a', description: 'b', inputVariables: [] }], connectedAt: 2000 },
      ];

      const { app } = await createTestApp(p2pRoutes, '/api/p2p', {
        _p2pManager: { getPeers: () => peers },
      });

      const res = await app.inject({ method: 'GET', url: '/api/p2p/peers' });
      assert.equal(res.statusCode, 200);

      const body = JSON.parse(res.payload);
      assert.equal(body.length, 2);
      assert.equal(body[0].peerName, 'Node1');
      assert.equal(body[1].agents.length, 1);
    });
  });

  describe('GET /api/p2p/agents', () => {
    it('should return empty array when P2PManager is not set', async () => {
      const { app } = await createTestApp(p2pRoutes, '/api/p2p');

      const res = await app.inject({ method: 'GET', url: '/api/p2p/agents' });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(JSON.parse(res.payload), []);
    });

    it('should return remote agents from manager', async () => {
      const agents = [
        { name: 'helper', description: 'A helper', inputVariables: ['q'], peerId: 'abc', peerName: 'Node1' },
      ];

      const { app } = await createTestApp(p2pRoutes, '/api/p2p', {
        _p2pManager: { getRemoteAgents: () => agents },
      });

      const res = await app.inject({ method: 'GET', url: '/api/p2p/agents' });
      assert.equal(res.statusCode, 200);

      const body = JSON.parse(res.payload);
      assert.equal(body.length, 1);
      assert.equal(body[0].name, 'helper');
      assert.equal(body[0].peerId, 'abc');
      assert.equal(body[0].peerName, 'Node1');
    });
  });

  describe('POST /api/p2p/agents/:peerId/:agentName/stream', () => {
    it('should return 503 when P2PManager is not set', async () => {
      const { app } = await createTestApp(p2pRoutes, '/api/p2p');

      const res = await app.inject({
        method: 'POST',
        url: '/api/p2p/agents/peer123/my-agent/stream',
        payload: { input: { q: 'hello' } },
      });
      assert.equal(res.statusCode, 503);
      const body = JSON.parse(res.payload);
      assert.ok(body.error.includes('P2P not enabled'));
    });
  });

  describe('GET /api/p2p/llms', () => {
    it('should return empty array when P2PManager is not set', async () => {
      const { app } = await createTestApp(p2pRoutes, '/api/p2p');

      const res = await app.inject({ method: 'GET', url: '/api/p2p/llms' });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(JSON.parse(res.payload), []);
    });

    it('should return remote LLMs from manager', async () => {
      const llms = [
        { name: 'gpt-4', provider: 'openai', model: 'gpt-4-turbo', peerId: 'abc', peerName: 'Node1' },
        { name: 'llama', provider: 'local', model: 'llama-3-8b', peerId: 'def', peerName: 'Node2' },
      ];

      const { app } = await createTestApp(p2pRoutes, '/api/p2p', {
        _p2pManager: { getRemoteModels: () => llms },
      });

      const res = await app.inject({ method: 'GET', url: '/api/p2p/llms' });
      assert.equal(res.statusCode, 200);

      const body = JSON.parse(res.payload);
      assert.equal(body.length, 2);
      assert.equal(body[0].name, 'gpt-4');
      assert.equal(body[0].provider, 'openai');
      assert.equal(body[1].peerName, 'Node2');
    });
  });

  describe('POST /api/p2p/llms/:peerId/:modelName/stream', () => {
    it('should return 503 when P2PManager is not set', async () => {
      const { app } = await createTestApp(p2pRoutes, '/api/p2p');

      const res = await app.inject({
        method: 'POST',
        url: '/api/p2p/llms/peer123/gpt-4/stream',
        payload: { message: 'hello' },
      });
      assert.equal(res.statusCode, 503);
      const body = JSON.parse(res.payload);
      assert.ok(body.error.includes('P2P not enabled'));
    });
  });
});

describe('P2P Agent Schema', () => {
  it('should accept p2p: true on agent definition', async () => {
    const { AgentDefinitionSchema } = await import('../../lib/agents/types.ts');
    const parsed = AgentDefinitionSchema.parse({
      name: 'test',
      description: 'Test agent',
      prompt: { system: 'hello' },
      p2p: true,
    });
    assert.equal(parsed.p2p, true);
  });

  it('should accept p2p: { leverage: true, share: true }', async () => {
    const { AgentDefinitionSchema } = await import('../../lib/agents/types.ts');
    const parsed = AgentDefinitionSchema.parse({
      name: 'test',
      description: 'Test agent',
      prompt: { system: 'hello' },
      p2p: { leverage: true, share: true },
    });
    assert.deepEqual(parsed.p2p, { leverage: true, share: true });
  });

  it('should accept missing p2p field', async () => {
    const { AgentDefinitionSchema } = await import('../../lib/agents/types.ts');
    const parsed = AgentDefinitionSchema.parse({
      name: 'test',
      description: 'Test agent',
      prompt: { system: 'hello' },
    });
    assert.equal(parsed.p2p, undefined);
  });

  it('resolveP2PConfig should resolve all variants', async () => {
    const { resolveP2PConfig } = await import('../../lib/agents/types.ts');

    assert.deepEqual(resolveP2PConfig(undefined), { leverage: false, share: false });
    assert.deepEqual(resolveP2PConfig(false), { leverage: false, share: false });
    assert.deepEqual(resolveP2PConfig(true), { leverage: 'local-first', share: true });
    assert.deepEqual(resolveP2PConfig({ leverage: true, share: false }), { leverage: 'local-first', share: false });
    assert.deepEqual(resolveP2PConfig({ leverage: false, share: true }), { leverage: false, share: true });
    assert.deepEqual(resolveP2PConfig({ leverage: 'remote-first', share: false }), { leverage: 'remote-first', share: false });
    assert.deepEqual(resolveP2PConfig({ leverage: 'remote-only', share: false }), { leverage: 'remote-only', share: false });
  });
});
