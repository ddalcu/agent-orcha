import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { P2PManager } from '../../lib/p2p/p2p-manager.ts';
import type { PeerInfo } from '../../lib/p2p/types.ts';

// Minimal mock orchestrator — just enough for P2PManager constructor
function createMockOrchestrator() {
  const tmpDir = path.join(os.tmpdir(), `orcha-test-p2p-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  return {
    workspaceRoot: tmpDir,
    tasks: {
      getManager: () => ({
        listTasks: (_filters?: any) => [],
      }),
    },
    cleanup: () => {
      try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
    },
  };
}

function createMockPeerInfo(peerId: string, peerName: string, load = 0): PeerInfo {
  return {
    peerId,
    peerName,
    version: '1.0.0',
    agents: [],
    models: [],
    load,
    connectedAt: Date.now(),
  };
}

// Inject a peer into the P2PManager's private peers Map
function injectPeer(manager: P2PManager, info: PeerInfo): void {
  const peers = (manager as any).peers as Map<string, { info: PeerInfo; protocol: any }>;
  peers.set(info.peerId, { info, protocol: { send: () => {}, isDestroyed: false } });
}

// Access private inFlightCounts
function getInFlightCounts(manager: P2PManager): Map<string, number> {
  return (manager as any).inFlightCounts;
}

describe('P2P Load Balancing', () => {
  let mock: ReturnType<typeof createMockOrchestrator>;
  let manager: P2PManager;

  beforeEach(() => {
    mock = createMockOrchestrator();
    manager = new P2PManager(mock as any);
  });

  // --- selectBestPeer ---

  describe('selectBestPeer', () => {
    it('returns the only candidate when there is one', () => {
      const candidates = [{ peerId: 'peer-a', model: 'flux', peerName: 'A' }];
      const result = manager.selectBestPeer(candidates);
      assert.equal(result.peerId, 'peer-a');
    });

    it('selects peer with lower reported load', () => {
      injectPeer(manager, createMockPeerInfo('peer-a', 'PeerA', 5));
      injectPeer(manager, createMockPeerInfo('peer-b', 'PeerB', 1));

      const candidates = [
        { peerId: 'peer-a', model: 'flux' },
        { peerId: 'peer-b', model: 'flux' },
      ];

      // peer-b has load=1, peer-a has load=5 → should pick peer-b
      const result = manager.selectBestPeer(candidates);
      assert.equal(result.peerId, 'peer-b');
    });

    it('selects peer with fewer in-flight requests', () => {
      injectPeer(manager, createMockPeerInfo('peer-a', 'PeerA', 0));
      injectPeer(manager, createMockPeerInfo('peer-b', 'PeerB', 0));

      // Simulate 3 in-flight requests to peer-a, 0 to peer-b
      const inFlight = getInFlightCounts(manager);
      inFlight.set('peer-a', 3);

      const candidates = [
        { peerId: 'peer-a', model: 'flux' },
        { peerId: 'peer-b', model: 'flux' },
      ];

      const result = manager.selectBestPeer(candidates);
      assert.equal(result.peerId, 'peer-b');
    });

    it('combines in-flight and reported load for scoring', () => {
      injectPeer(manager, createMockPeerInfo('peer-a', 'PeerA', 2));  // reported load=2
      injectPeer(manager, createMockPeerInfo('peer-b', 'PeerB', 0));  // reported load=0

      // peer-b has 4 in-flight from us
      const inFlight = getInFlightCounts(manager);
      inFlight.set('peer-b', 4);

      // peer-a score: 0 (in-flight) + 2 (load) = 2
      // peer-b score: 4 (in-flight) + 0 (load) = 4
      const candidates = [
        { peerId: 'peer-a', model: 'flux' },
        { peerId: 'peer-b', model: 'flux' },
      ];

      const result = manager.selectBestPeer(candidates);
      assert.equal(result.peerId, 'peer-a');
    });

    it('distributes evenly among tied peers', () => {
      injectPeer(manager, createMockPeerInfo('peer-a', 'PeerA', 0));
      injectPeer(manager, createMockPeerInfo('peer-b', 'PeerB', 0));
      injectPeer(manager, createMockPeerInfo('peer-c', 'PeerC', 0));

      const candidates = [
        { peerId: 'peer-a', model: 'flux' },
        { peerId: 'peer-b', model: 'flux' },
        { peerId: 'peer-c', model: 'flux' },
      ];

      // Run many selections — all three should appear (random tie-break)
      const counts = new Map<string, number>();
      for (let i = 0; i < 300; i++) {
        const result = manager.selectBestPeer(candidates);
        counts.set(result.peerId, (counts.get(result.peerId) ?? 0) + 1);
      }

      // Each peer should get selected at least some times (>10% each)
      assert.ok(counts.get('peer-a')! > 30, `peer-a selected ${counts.get('peer-a')} times, expected >30`);
      assert.ok(counts.get('peer-b')! > 30, `peer-b selected ${counts.get('peer-b')} times, expected >30`);
      assert.ok(counts.get('peer-c')! > 30, `peer-c selected ${counts.get('peer-c')} times, expected >30`);
    });

    it('handles unknown peers gracefully (defaults to 0 load)', () => {
      // Don't inject peers — they won't be in the peers Map
      const candidates = [
        { peerId: 'unknown-a', model: 'flux' },
        { peerId: 'unknown-b', model: 'flux' },
      ];

      // Should not throw, just pick randomly among unknowns
      const result = manager.selectBestPeer(candidates);
      assert.ok(['unknown-a', 'unknown-b'].includes(result.peerId));
    });

    it('prefers unknown peer over loaded known peer', () => {
      injectPeer(manager, createMockPeerInfo('peer-a', 'PeerA', 10));
      const inFlight = getInFlightCounts(manager);
      inFlight.set('peer-a', 5);

      // peer-a score: 5 + 10 = 15
      // peer-b score: 0 + 0 = 0 (unknown defaults)
      const candidates = [
        { peerId: 'peer-a', model: 'flux' },
        { peerId: 'peer-b', model: 'flux' },
      ];

      const result = manager.selectBestPeer(candidates);
      assert.equal(result.peerId, 'peer-b');
    });
  });

  // --- In-flight tracking ---

  describe('in-flight tracking', () => {
    it('increments and decrements correctly', () => {
      const inFlight = getInFlightCounts(manager);
      const inc = (manager as any).incrementInFlight.bind(manager);
      const dec = (manager as any).decrementInFlight.bind(manager);

      assert.equal(inFlight.get('peer-a'), undefined);

      inc('peer-a');
      assert.equal(inFlight.get('peer-a'), 1);

      inc('peer-a');
      assert.equal(inFlight.get('peer-a'), 2);

      inc('peer-a');
      assert.equal(inFlight.get('peer-a'), 3);

      dec('peer-a');
      assert.equal(inFlight.get('peer-a'), 2);

      dec('peer-a');
      assert.equal(inFlight.get('peer-a'), 1);

      dec('peer-a');
      // Should be cleaned up (deleted from map)
      assert.equal(inFlight.get('peer-a'), undefined);
      assert.equal(inFlight.has('peer-a'), false);
    });

    it('handles decrement below zero gracefully', () => {
      const inFlight = getInFlightCounts(manager);
      const dec = (manager as any).decrementInFlight.bind(manager);

      // Decrement without prior increment
      dec('peer-x');
      assert.equal(inFlight.has('peer-x'), false);
    });

    it('tracks multiple peers independently', () => {
      const inFlight = getInFlightCounts(manager);
      const inc = (manager as any).incrementInFlight.bind(manager);
      const dec = (manager as any).decrementInFlight.bind(manager);

      inc('peer-a');
      inc('peer-a');
      inc('peer-b');
      inc('peer-c');
      inc('peer-c');
      inc('peer-c');

      assert.equal(inFlight.get('peer-a'), 2);
      assert.equal(inFlight.get('peer-b'), 1);
      assert.equal(inFlight.get('peer-c'), 3);

      dec('peer-b');
      assert.equal(inFlight.has('peer-b'), false);
      assert.equal(inFlight.get('peer-a'), 2);
      assert.equal(inFlight.get('peer-c'), 3);
    });
  });

  // --- getLocalLoad ---

  describe('getLocalLoad', () => {
    it('returns 0 when no tasks are working', () => {
      assert.equal(manager.getLocalLoad(), 0);
    });

    it('counts only incoming P2P tasks', () => {
      const mockTasks = [
        { status: 'working', p2p: { direction: 'incoming' } },
        { status: 'working', p2p: { direction: 'incoming' } },
        { status: 'working', p2p: { direction: 'outgoing' } },
        { status: 'working' },  // no p2p field
      ];

      (mock.tasks.getManager as any) = () => ({
        listTasks: () => mockTasks,
      });

      assert.equal(manager.getLocalLoad(), 2);
    });
  });

  // --- Catalog load field ---

  describe('catalog load broadcasting', () => {
    it('broadcastCatalog includes load field', () => {
      injectPeer(manager, createMockPeerInfo('peer-a', 'PeerA', 0));

      const sentMessages: any[] = [];
      const peers = (manager as any).peers as Map<string, any>;
      const peer = peers.get('peer-a')!;
      peer.protocol.send = (msg: any) => sentMessages.push(msg);

      // Mock getLocalP2PAgents and getLocalSharedModels
      (manager as any).getLocalP2PAgents = () => [];
      (manager as any).getLocalSharedModels = () => [];

      manager.broadcastCatalog();

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0].type, 'catalog');
      assert.equal(typeof sentMessages[0].load, 'number');
    });

    it('stores load from incoming catalog', () => {
      injectPeer(manager, createMockPeerInfo('peer-a', 'PeerA', 0));

      const peers = (manager as any).peers as Map<string, any>;
      const peerEntry = peers.get('peer-a')!;

      // Simulate receiving a catalog with load
      const handlers = new Map<string, Function>();
      // Re-setup handlers to capture the catalog handler
      const protocol = {
        on: (event: string, handler: Function) => { handlers.set(event, handler); },
        send: () => {},
        isDestroyed: false,
      };
      peers.set('peer-a', { info: peerEntry.info, protocol });

      // Call setupPeerHandlers
      (manager as any).setupPeerHandlers('peer-a', protocol);

      // Invoke the catalog handler with load=7
      const catalogHandler = handlers.get('catalog')!;
      catalogHandler({ type: 'catalog', agents: [], models: [], load: 7, peerName: 'PeerA' });

      assert.equal(peerEntry.info.load, 7);
    });
  });

  // --- Broadcast timing ---

  describe('broadcast timing', () => {
    it('broadcastCatalog reflects current load from task manager', () => {
      injectPeer(manager, createMockPeerInfo('peer-a', 'PeerA', 0));

      const sentMessages: any[] = [];
      const peers = (manager as any).peers as Map<string, any>;
      peers.get('peer-a')!.protocol.send = (msg: any) => sentMessages.push(msg);
      (manager as any).getLocalP2PAgents = () => [];
      (manager as any).getLocalSharedModels = () => [];

      // First broadcast with 0 load
      manager.broadcastCatalog();
      assert.equal(sentMessages[0].load, 0);

      // Simulate 3 working incoming tasks
      (mock.tasks.getManager as any) = () => ({
        listTasks: () => [
          { status: 'working', p2p: { direction: 'incoming' } },
          { status: 'working', p2p: { direction: 'incoming' } },
          { status: 'working', p2p: { direction: 'incoming' } },
        ],
      });

      // Second broadcast should reflect new load
      manager.broadcastCatalog();
      assert.equal(sentMessages[1].load, 3);

      // Simulate tasks completed
      (mock.tasks.getManager as any) = () => ({
        listTasks: () => [],
      });

      manager.broadcastCatalog();
      assert.equal(sentMessages[2].load, 0);
    });

    it('peers see load changes via catalog updates', () => {
      injectPeer(manager, createMockPeerInfo('peer-a', 'PeerA', 0));
      injectPeer(manager, createMockPeerInfo('peer-b', 'PeerB', 0));

      const peers = (manager as any).peers as Map<string, any>;

      // Simulate catalog from peer-a saying load=5
      const handlersA = new Map<string, Function>();
      const protocolA = {
        on: (event: string, handler: Function) => { handlersA.set(event, handler); },
        send: () => {},
        isDestroyed: false,
      };
      peers.set('peer-a', { info: peers.get('peer-a')!.info, protocol: protocolA });
      (manager as any).setupPeerHandlers('peer-a', protocolA);
      handlersA.get('catalog')!({ type: 'catalog', agents: [], models: [], load: 5, peerName: 'PeerA' });

      // Now selectBestPeer should prefer peer-b (load=0) over peer-a (load=5)
      const candidates = [
        { peerId: 'peer-a', model: 'flux' },
        { peerId: 'peer-b', model: 'flux' },
      ];
      const result = manager.selectBestPeer(candidates);
      assert.equal(result.peerId, 'peer-b');

      // Simulate peer-a finishes, sends load=0; peer-b gets busy, sends load=3
      handlersA.get('catalog')!({ type: 'catalog', agents: [], models: [], load: 0, peerName: 'PeerA' });
      const handlersB = new Map<string, Function>();
      const protocolB = {
        on: (event: string, handler: Function) => { handlersB.set(event, handler); },
        send: () => {},
        isDestroyed: false,
      };
      peers.set('peer-b', { info: peers.get('peer-b')!.info, protocol: protocolB });
      (manager as any).setupPeerHandlers('peer-b', protocolB);
      handlersB.get('catalog')!({ type: 'catalog', agents: [], models: [], load: 3, peerName: 'PeerB' });

      // Now peer-a should be preferred
      const result2 = manager.selectBestPeer(candidates);
      assert.equal(result2.peerId, 'peer-a');
    });
  });

  // --- End-to-end peer selection simulation ---

  describe('multi-request distribution simulation', () => {
    it('distributes requests across peers as in-flight counts grow', () => {
      injectPeer(manager, createMockPeerInfo('peer-a', 'PeerA', 0));
      injectPeer(manager, createMockPeerInfo('peer-b', 'PeerB', 0));
      injectPeer(manager, createMockPeerInfo('peer-c', 'PeerC', 0));

      const inc = (manager as any).incrementInFlight.bind(manager);
      const dec = (manager as any).decrementInFlight.bind(manager);

      const candidates = [
        { peerId: 'peer-a', model: 'flux' },
        { peerId: 'peer-b', model: 'flux' },
        { peerId: 'peer-c', model: 'flux' },
      ];

      // Simulate sequential requests, each time picking best peer and incrementing
      const selections: string[] = [];
      for (let i = 0; i < 6; i++) {
        const best = manager.selectBestPeer(candidates);
        selections.push(best.peerId);
        inc(best.peerId);
      }

      // With 6 requests and 3 peers, each should get exactly 2
      const counts = new Map<string, number>();
      for (const s of selections) {
        counts.set(s, (counts.get(s) ?? 0) + 1);
      }
      assert.equal(counts.get('peer-a'), 2, `peer-a got ${counts.get('peer-a')}, expected 2`);
      assert.equal(counts.get('peer-b'), 2, `peer-b got ${counts.get('peer-b')}, expected 2`);
      assert.equal(counts.get('peer-c'), 2, `peer-c got ${counts.get('peer-c')}, expected 2`);

      // Now complete all peer-a requests
      dec('peer-a');
      dec('peer-a');

      // Next request should go to peer-a (0 in-flight vs 2 for others)
      const next = manager.selectBestPeer(candidates);
      assert.equal(next.peerId, 'peer-a');
    });

    it('factors both in-flight and reported load for multi-caller scenario', () => {
      injectPeer(manager, createMockPeerInfo('peer-a', 'PeerA', 3));  // another caller is using it
      injectPeer(manager, createMockPeerInfo('peer-b', 'PeerB', 0));
      injectPeer(manager, createMockPeerInfo('peer-c', 'PeerC', 1));

      const inc = (manager as any).incrementInFlight.bind(manager);

      const candidates = [
        { peerId: 'peer-a', model: 'flux' },
        { peerId: 'peer-b', model: 'flux' },
        { peerId: 'peer-c', model: 'flux' },
      ];

      // First request: peer-b wins (score 0)
      const r1 = manager.selectBestPeer(candidates);
      assert.equal(r1.peerId, 'peer-b');
      inc('peer-b');

      // Second request: peer-b score=1, peer-c score=1, peer-a score=3 → tie between b and c
      const r2 = manager.selectBestPeer(candidates);
      assert.ok(['peer-b', 'peer-c'].includes(r2.peerId), `expected peer-b or peer-c, got ${r2.peerId}`);
      inc(r2.peerId);

      // Third: if r2 was peer-b → b=2, c=1, a=3 → c wins
      //        if r2 was peer-c → b=1, c=2, a=3 → b wins
      const r3 = manager.selectBestPeer(candidates);
      assert.ok(['peer-b', 'peer-c'].includes(r3.peerId));

      // peer-a should never be selected while it has load=3
      const allSelections = [r1.peerId, r2.peerId, r3.peerId];
      assert.ok(!allSelections.includes('peer-a'), 'peer-a should not be selected while heavily loaded');
    });
  });

  // --- resolveP2PConfig leverage modes ---

  describe('resolveP2PConfig leverage modes', () => {
    it('maps boolean true to local-first', async () => {
      const { resolveP2PConfig } = await import('../../lib/agents/types.ts');
      const result = resolveP2PConfig(true);
      assert.equal(result.leverage, 'local-first');
      assert.equal(result.share, true);
    });

    it('maps boolean false to false', async () => {
      const { resolveP2PConfig } = await import('../../lib/agents/types.ts');
      const result = resolveP2PConfig(false);
      assert.equal(result.leverage, false);
    });

    it('passes through string modes', async () => {
      const { resolveP2PConfig } = await import('../../lib/agents/types.ts');
      for (const mode of ['local-first', 'remote-first', 'remote-only'] as const) {
        const result = resolveP2PConfig({ leverage: mode, share: false });
        assert.equal(result.leverage, mode);
      }
    });

    it('maps leverage: true in object to local-first', async () => {
      const { resolveP2PConfig } = await import('../../lib/agents/types.ts');
      const result = resolveP2PConfig({ leverage: true, share: false });
      assert.equal(result.leverage, 'local-first');
    });

    it('maps leverage: false in object to false', async () => {
      const { resolveP2PConfig } = await import('../../lib/agents/types.ts');
      const result = resolveP2PConfig({ leverage: false, share: true });
      assert.equal(result.leverage, false);
      assert.equal(result.share, true);
    });
  });

  // --- selectPeersRanked ---

  describe('selectPeersRanked', () => {
    it('returns single candidate as-is', () => {
      const candidates = [{ peerId: 'peer-a', model: 'flux', peerName: 'A' }];
      const result = manager.selectPeersRanked(candidates);
      assert.equal(result.length, 1);
      assert.equal(result[0]!.peerId, 'peer-a');
    });

    it('returns a copy, not the original array', () => {
      const candidates = [{ peerId: 'peer-a', model: 'flux' }];
      const result = manager.selectPeersRanked(candidates);
      assert.notStrictEqual(result, candidates);
    });

    it('sorts by load ascending', () => {
      injectPeer(manager, createMockPeerInfo('peer-a', 'PeerA', 5));
      injectPeer(manager, createMockPeerInfo('peer-b', 'PeerB', 1));
      injectPeer(manager, createMockPeerInfo('peer-c', 'PeerC', 3));

      const candidates = [
        { peerId: 'peer-a', model: 'flux' },
        { peerId: 'peer-b', model: 'flux' },
        { peerId: 'peer-c', model: 'flux' },
      ];

      const result = manager.selectPeersRanked(candidates);
      assert.equal(result[0]!.peerId, 'peer-b'); // load=1
      assert.equal(result[1]!.peerId, 'peer-c'); // load=3
      assert.equal(result[2]!.peerId, 'peer-a'); // load=5
    });

    it('combines inFlight + peerLoad', () => {
      injectPeer(manager, createMockPeerInfo('peer-a', 'PeerA', 2));
      injectPeer(manager, createMockPeerInfo('peer-b', 'PeerB', 0));

      const inFlight = getInFlightCounts(manager);
      inFlight.set('peer-b', 4);

      // peer-a score: 0 + 2 = 2
      // peer-b score: 4 + 0 = 4
      const candidates = [
        { peerId: 'peer-a', model: 'flux' },
        { peerId: 'peer-b', model: 'flux' },
      ];

      const result = manager.selectPeersRanked(candidates);
      assert.equal(result[0]!.peerId, 'peer-a');
      assert.equal(result[1]!.peerId, 'peer-b');
    });

    it('shuffles within same score tier', () => {
      injectPeer(manager, createMockPeerInfo('peer-a', 'PeerA', 0));
      injectPeer(manager, createMockPeerInfo('peer-b', 'PeerB', 0));
      injectPeer(manager, createMockPeerInfo('peer-c', 'PeerC', 0));

      const candidates = [
        { peerId: 'peer-a', model: 'flux' },
        { peerId: 'peer-b', model: 'flux' },
        { peerId: 'peer-c', model: 'flux' },
      ];

      // Run many times — all three should appear in first position at least once
      const firstPositionCounts = new Map<string, number>();
      for (let i = 0; i < 300; i++) {
        const result = manager.selectPeersRanked(candidates);
        const first = result[0]!.peerId;
        firstPositionCounts.set(first, (firstPositionCounts.get(first) ?? 0) + 1);
      }

      assert.ok(firstPositionCounts.get('peer-a')! > 30, `peer-a first ${firstPositionCounts.get('peer-a')} times, expected >30`);
      assert.ok(firstPositionCounts.get('peer-b')! > 30, `peer-b first ${firstPositionCounts.get('peer-b')} times, expected >30`);
      assert.ok(firstPositionCounts.get('peer-c')! > 30, `peer-c first ${firstPositionCounts.get('peer-c')} times, expected >30`);
    });

    it('returns all candidates (no filtering)', () => {
      injectPeer(manager, createMockPeerInfo('peer-a', 'PeerA', 10));
      injectPeer(manager, createMockPeerInfo('peer-b', 'PeerB', 1));

      const candidates = [
        { peerId: 'peer-a', model: 'flux' },
        { peerId: 'peer-b', model: 'flux' },
      ];

      const result = manager.selectPeersRanked(candidates);
      assert.equal(result.length, 2);
    });
  });
});
