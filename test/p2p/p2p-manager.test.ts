import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { P2PManager } from '../../lib/p2p/p2p-manager.ts';
import type { AgentDefinition } from '../../lib/agents/types.ts';

function makeAgent(name: string, p2p: boolean): AgentDefinition {
  return {
    name,
    description: `${name} description`,
    version: '1.0.0',
    llm: 'default',
    prompt: { system: 'You are helpful', inputVariables: ['input'] },
    tools: [],
    p2p,
    sampleQuestions: [`Ask ${name} something`],
  } as AgentDefinition;
}

function createMockOrchestrator(agents: AgentDefinition[], streamChunks: unknown[] = []) {
  return {
    workspaceRoot: '/tmp/orcha-test-p2p',
    agents: {
      list: () => agents,
      get: (name: string) => agents.find(a => a.name === name),
      names: () => agents.map(a => a.name),
    },
    tasks: {
      getManager: () => ({
        trackP2P: (_k: string, _t: string, _i: unknown, _p2p: unknown, _s?: string) => ({ id: 'task-1' }),
        registerAbort: () => {},
        resolve: () => {},
        reject: () => {},
        cancelTask: () => {},
      }),
    },
    streamAgent: async function* (_name: string, _input: Record<string, unknown>, _sessionId: string, _signal?: AbortSignal) {
      for (const chunk of streamChunks) {
        yield chunk;
      }
    },
  } as any;
}

describe('P2PManager', () => {
  const agentA = makeAgent('shared-agent', true);
  const agentB = makeAgent('private-agent', false);
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv['P2P_NETWORK_KEY'] = process.env['P2P_NETWORK_KEY'];
    savedEnv['P2P_PEER_NAME'] = process.env['P2P_PEER_NAME'];
    savedEnv['P2P_RATE_LIMIT'] = process.env['P2P_RATE_LIMIT'];
    savedEnv['P2P_SHARE_LLMS'] = process.env['P2P_SHARE_LLMS'];
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  describe('constructor', () => {
    it('should use default network key and peer name', () => {
      delete process.env['P2P_NETWORK_KEY'];
      delete process.env['P2P_PEER_NAME'];
      const orch = createMockOrchestrator([agentA]);
      const mgr = new P2PManager(orch);
      const status = mgr.getStatus();
      assert.equal(status.enabled, true); // P2PManager always reports enabled
      assert.equal(status.connected, false); // not started yet
      assert.equal(status.peerCount, 0);
    });

    it('should read config from env vars', () => {
      process.env['P2P_PEER_NAME'] = 'TestPeer';
      process.env['P2P_NETWORK_KEY'] = 'custom-key';
      const orch = createMockOrchestrator([agentA]);
      const mgr = new P2PManager(orch);
      const status = mgr.getStatus();
      assert.equal(status.peerName, 'TestPeer');
      assert.equal(status.networkKey, 'custom-key');
    });

    it('should parse rate limit from env', () => {
      process.env['P2P_RATE_LIMIT'] = '120';
      const orch = createMockOrchestrator([agentA]);
      const mgr = new P2PManager(orch);
      assert.equal(mgr.rateLimit, 120);
    });

    it('should default rate limit to 60', () => {
      delete process.env['P2P_RATE_LIMIT'];
      const orch = createMockOrchestrator([agentA]);
      const mgr = new P2PManager(orch);
      assert.equal(mgr.rateLimit, 60);
    });
  });

  describe('status', () => {
    it('should report not started status', () => {
      const mgr = new P2PManager(createMockOrchestrator([agentA]));
      const status = mgr.getStatus();
      assert.equal(status.enabled, true);
      assert.equal(status.connected, false);
      assert.equal(status.peerCount, 0);
    });
  });

  describe('rate limiting', () => {
    it('should allow setting rate limit', () => {
      const mgr = new P2PManager(createMockOrchestrator([]));
      mgr.setRateLimit(100);
      assert.equal(mgr.rateLimit, 100);
    });

    it('should not allow negative rate limit', () => {
      const mgr = new P2PManager(createMockOrchestrator([]));
      mgr.setRateLimit(-5);
      assert.equal(mgr.rateLimit, 0);
    });

    it('should allow zero rate limit (unlimited)', () => {
      process.env['P2P_RATE_LIMIT'] = '0';
      const mgr = new P2PManager(createMockOrchestrator([]));
      assert.equal(mgr.rateLimit, 0);
    });
  });

  describe('remote agents', () => {
    it('should return empty array when no peers', () => {
      const mgr = new P2PManager(createMockOrchestrator([agentA]));
      assert.deepEqual(mgr.getRemoteAgents(), []);
    });

    it('should return empty peers when not started', () => {
      const mgr = new P2PManager(createMockOrchestrator([agentA]));
      assert.deepEqual(mgr.getPeers(), []);
    });
  });

  describe('remote LLMs', () => {
    it('should return empty array when no peers', () => {
      const mgr = new P2PManager(createMockOrchestrator([agentA]));
      assert.deepEqual(mgr.getRemoteLLMs(), []);
    });
  });

  describe('invoke errors', () => {
    it('should error when invoking non-existent peer', async () => {
      const mgr = new P2PManager(createMockOrchestrator([agentA]));
      await assert.rejects(
        async () => {
          const gen = mgr.invokeRemoteAgent('fake-peer-id', 'agent', {}, 'sess');
          await gen.next();
        },
        { message: /not connected/ },
      );
    });

    it('should error when invoking LLM on non-existent peer', async () => {
      const mgr = new P2PManager(createMockOrchestrator([agentA]));
      await assert.rejects(
        async () => {
          const gen = mgr.invokeRemoteLLM('fake-peer-id', 'model', []);
          await gen.next();
        },
        { message: /not connected/ },
      );
    });
  });

  describe('close', () => {
    it('should be safe to close when not started', async () => {
      const mgr = new P2PManager(createMockOrchestrator([]));
      await mgr.close(); // Should not throw
    });
  });

  describe('catalog filtering', () => {
    it('should only expose p2p-enabled agents', () => {
      const orch = createMockOrchestrator([agentA, agentB]);
      const mgr = new P2PManager(orch);
      // Access internal method via casting
      const agents = (mgr as any).getLocalP2PAgents();
      assert.equal(agents.length, 1);
      assert.equal(agents[0].name, 'shared-agent');
    });

    it('should include agent metadata in catalog', () => {
      const orch = createMockOrchestrator([agentA]);
      const mgr = new P2PManager(orch);
      const agents = (mgr as any).getLocalP2PAgents();
      assert.equal(agents[0].name, 'shared-agent');
      assert.equal(agents[0].description, 'shared-agent description');
      assert.deepEqual(agents[0].inputVariables, ['input']);
      assert.deepEqual(agents[0].sampleQuestions, ['Ask shared-agent something']);
    });
  });
});
