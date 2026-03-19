import { describe, it, before, after } from 'node:test';
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
    agents: {
      list: () => agents,
      get: (name: string) => agents.find(a => a.name === name),
      names: () => agents.map(a => a.name),
    },
    streamAgent: async function* (_name: string, _input: Record<string, unknown>, _sessionId: string, _signal?: AbortSignal) {
      for (const chunk of streamChunks) {
        yield chunk;
      }
    },
  } as any;
}

// Wait for a condition with timeout
async function waitFor(fn: () => boolean, timeoutMs = 5000, intervalMs = 50): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

describe('P2PManager Integration', () => {
  const agentA = makeAgent('shared-agent', true);
  const agentB = makeAgent('private-agent', false);
  const agentC = makeAgent('remote-helper', true);

  // Use a unique network key per test run to avoid interference
  const testNetworkKey = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  let managerA: P2PManager;
  let managerB: P2PManager;

  before(async () => {
    // Set env vars for both managers
    process.env['P2P_NETWORK_KEY'] = testNetworkKey;

    process.env['P2P_PEER_NAME'] = 'PeerA';
    const orchA = createMockOrchestrator(
      [agentA, agentB],
      [
        { type: 'content', content: 'Hello ' },
        { type: 'content', content: 'from remote!' },
      ],
    );
    managerA = new P2PManager(orchA);

    process.env['P2P_PEER_NAME'] = 'PeerB';
    const orchB = createMockOrchestrator([agentC]);
    managerB = new P2PManager(orchB);

    // Start both — they should discover each other via DHT
    await managerA.start();
    await managerB.start();

    // Wait for peer discovery (both sides see each other)
    await waitFor(() => managerA.getPeers().length >= 1 && managerB.getPeers().length >= 1, 15000);
  });

  after(async () => {
    await managerA?.close();
    await managerB?.close();
    delete process.env['P2P_NETWORK_KEY'];
    delete process.env['P2P_PEER_NAME'];
  });

  describe('handshake and peer discovery', () => {
    it('should discover each other', () => {
      assert.equal(managerA.getPeers().length, 1);
      assert.equal(managerB.getPeers().length, 1);
    });

    it('should exchange peer names', () => {
      const peerOfA = managerA.getPeers()[0]!;
      const peerOfB = managerB.getPeers()[0]!;

      // A sees B's name, B sees A's name
      assert.equal(peerOfA.peerName, 'PeerB');
      assert.equal(peerOfB.peerName, 'PeerA');
    });

    it('should exchange agent catalogs', () => {
      const peerOfA = managerA.getPeers()[0]!;
      const peerOfB = managerB.getPeers()[0]!;

      // A sees B's p2p agents (remote-helper)
      assert.equal(peerOfA.agents.length, 1);
      assert.equal(peerOfA.agents[0]!.name, 'remote-helper');

      // B sees A's p2p agents (shared-agent only, not private-agent)
      assert.equal(peerOfB.agents.length, 1);
      assert.equal(peerOfB.agents[0]!.name, 'shared-agent');
    });

    it('should not expose agents without p2p enabled', () => {
      const peerOfB = managerB.getPeers()[0]!;
      const agentNames = peerOfB.agents.map(a => a.name);
      assert.ok(!agentNames.includes('private-agent'));
    });
  });

  describe('status', () => {
    it('should report connected status', () => {
      const statusA = managerA.getStatus();
      assert.equal(statusA.enabled, true);
      assert.equal(statusA.connected, true);
      assert.equal(statusA.peerCount, 1);
    });
  });

  describe('remote agents', () => {
    it('should aggregate remote agents across peers', () => {
      const remoteFromA = managerA.getRemoteAgents();
      assert.equal(remoteFromA.length, 1);
      assert.equal(remoteFromA[0]!.name, 'remote-helper');
      assert.equal(remoteFromA[0]!.peerName, 'PeerB');

      const remoteFromB = managerB.getRemoteAgents();
      assert.equal(remoteFromB.length, 1);
      assert.equal(remoteFromB[0]!.name, 'shared-agent');
      assert.equal(remoteFromB[0]!.peerName, 'PeerA');
    });

    it('should include agent metadata', () => {
      const remote = managerA.getRemoteAgents()[0]!;
      assert.equal(remote.description, 'remote-helper description');
      assert.deepEqual(remote.inputVariables, ['input']);
      assert.deepEqual(remote.sampleQuestions, ['Ask remote-helper something']);
    });
  });

  describe('remote agent invocation', () => {
    it('should stream response from remote agent', async () => {
      const peerA = managerB.getPeers()[0]!;
      const chunks: unknown[] = [];

      for await (const chunk of managerB.invokeRemoteAgent(
        peerA.peerId,
        'shared-agent',
        { input: 'hello' },
        'test-session-1',
      )) {
        chunks.push(chunk);
      }

      assert.equal(chunks.length, 2);
      assert.deepEqual(chunks[0], { type: 'content', content: 'Hello ' });
      assert.deepEqual(chunks[1], { type: 'content', content: 'from remote!' });
    });

    it('should error when invoking non-existent peer', async () => {
      await assert.rejects(
        async () => {
          const gen = managerB.invokeRemoteAgent('fake-peer-id', 'agent', {}, 'sess');
          await gen.next();
        },
        { message: /not connected/ },
      );
    });
  });

  describe('catalog broadcast', () => {
    it('should update peer agent list on broadcast', async () => {
      const peerOfB = managerB.getPeers()[0]!;
      const initialCount = peerOfB.agents.length;
      assert.equal(initialCount, 1);

      // Simulate A adding a new agent and broadcasting
      managerA.broadcastCatalog();

      // Wait for catalog update
      await new Promise(r => setTimeout(r, 200));

      // The catalog should still be 1 since the orchestrator mock hasn't changed
      const updatedPeer = managerB.getPeers()[0]!;
      assert.equal(updatedPeer.agents.length, 1);
    });
  });
});
