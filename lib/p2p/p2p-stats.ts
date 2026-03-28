import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger.ts';
import type { P2PDirectionStats, P2PNetworkStats, P2PDHTStats, P2PLeaderboardEntry, P2PTokenBreakdown } from './types.ts';

interface StatsFile {
  networks: Record<string, SerializedNetworkStats>;
  dhtSeq: number;
}

interface SerializedNetworkStats {
  served: P2PDirectionStats;
  consumed: P2PDirectionStats;
  lastUpdated: number;
}

function emptyDirectionStats(): P2PDirectionStats {
  return { totalInputTokens: 0, totalOutputTokens: 0, totalRequests: 0, byModel: [], byAgent: [] };
}

function findOrCreateBreakdown(list: P2PTokenBreakdown[], name: string): P2PTokenBreakdown {
  let entry = list.find(e => e.name === name);
  if (!entry) {
    entry = { name, inputTokens: 0, outputTokens: 0, requestCount: 0 };
    list.push(entry);
  }
  return entry;
}

export class P2PStats {
  private networks = new Map<string, { served: P2PDirectionStats; consumed: P2PDirectionStats; lastUpdated: number }>();
  private dhtSeq: number;
  private filePath: string;
  private dirty = false;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;
  private publishTimer: ReturnType<typeof setInterval> | null = null;
  private requestsSincePublish = 0;

  /** Cache of peer DHT stats — peerId -> { stats, fetchedAt } */
  private peerStatsCache = new Map<string, { stats: P2PDHTStats; fetchedAt: number }>();

  constructor(workspaceRoot: string) {
    this.filePath = path.join(workspaceRoot, '.p2p-stats.json');
    this.dhtSeq = 0;
    this.load();
  }

  // --- Persistence ---

  private load(): void {
    try {
      const raw: StatsFile = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      this.dhtSeq = raw.dhtSeq ?? 0;
      if (raw.networks) {
        for (const [key, stats] of Object.entries(raw.networks)) {
          this.networks.set(key, {
            served: stats.served ?? emptyDirectionStats(),
            consumed: stats.consumed ?? emptyDirectionStats(),
            lastUpdated: stats.lastUpdated ?? 0,
          });
        }
      }
    } catch {
      // File doesn't exist or is invalid — start fresh
    }
  }

  private save(): void {
    const data: StatsFile = { networks: {}, dhtSeq: this.dhtSeq };
    for (const [key, stats] of this.networks) {
      data.networks[key] = stats;
    }
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
    } catch (err: any) {
      logger.warn('[P2P Stats] Could not persist stats:', err.message);
    }
    this.dirty = false;
  }

  private scheduleSave(): void {
    if (this.saveTimeout) return;
    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = null;
      this.save();
    }, 5_000);
  }

  // --- Recording ---

  private getOrCreateNetwork(networkKey: string) {
    let net = this.networks.get(networkKey);
    if (!net) {
      net = { served: emptyDirectionStats(), consumed: emptyDirectionStats(), lastUpdated: 0 };
      this.networks.set(networkKey, net);
    }
    return net;
  }

  recordServed(networkKey: string, opts: { model?: string; agent?: string; inputTokens: number; outputTokens: number }): void {
    const net = this.getOrCreateNetwork(networkKey);
    net.served.totalInputTokens += opts.inputTokens;
    net.served.totalOutputTokens += opts.outputTokens;
    net.served.totalRequests++;
    if (opts.model) {
      const entry = findOrCreateBreakdown(net.served.byModel, opts.model);
      entry.inputTokens += opts.inputTokens;
      entry.outputTokens += opts.outputTokens;
      entry.requestCount++;
    }
    if (opts.agent) {
      const entry = findOrCreateBreakdown(net.served.byAgent, opts.agent);
      entry.inputTokens += opts.inputTokens;
      entry.outputTokens += opts.outputTokens;
      entry.requestCount++;
    }
    net.lastUpdated = Date.now();
    this.dirty = true;
    this.requestsSincePublish++;
    this.scheduleSave();
  }

  recordConsumed(networkKey: string, opts: { model?: string; agent?: string; inputTokens: number; outputTokens: number }): void {
    const net = this.getOrCreateNetwork(networkKey);
    net.consumed.totalInputTokens += opts.inputTokens;
    net.consumed.totalOutputTokens += opts.outputTokens;
    net.consumed.totalRequests++;
    if (opts.model) {
      const entry = findOrCreateBreakdown(net.consumed.byModel, opts.model);
      entry.inputTokens += opts.inputTokens;
      entry.outputTokens += opts.outputTokens;
      entry.requestCount++;
    }
    if (opts.agent) {
      const entry = findOrCreateBreakdown(net.consumed.byAgent, opts.agent);
      entry.inputTokens += opts.inputTokens;
      entry.outputTokens += opts.outputTokens;
      entry.requestCount++;
    }
    net.lastUpdated = Date.now();
    this.dirty = true;
    this.requestsSincePublish++;
    this.scheduleSave();
  }

  // --- Accessors ---

  getStats(networkKey: string): P2PNetworkStats | null {
    const net = this.networks.get(networkKey);
    if (!net) return null;
    return { networkKey, ...net };
  }

  /** Get compact stats summary for catalog messages */
  getCatalogStats(networkKey: string): { si: number; so: number; ci: number; co: number } | undefined {
    const net = this.networks.get(networkKey);
    if (!net) return undefined;
    return {
      si: net.served.totalInputTokens,
      so: net.served.totalOutputTokens,
      ci: net.consumed.totalInputTokens,
      co: net.consumed.totalOutputTokens,
    };
  }

  /** Check if stats should be published (dirty + enough requests or timer-triggered) */
  shouldPublish(): boolean {
    return this.dirty && this.requestsSincePublish >= 10;
  }

  // --- DHT Publishing ---

  async publishToDHT(dht: any, keyPair: any, networkKey: string, peerName: string): Promise<void> {
    const net = this.networks.get(networkKey);
    if (!net) return;

    const payload: P2PDHTStats = {
      v: 1,
      n: peerName,
      s: { i: net.served.totalInputTokens, o: net.served.totalOutputTokens, r: net.served.totalRequests },
      c: { i: net.consumed.totalInputTokens, o: net.consumed.totalOutputTokens, r: net.consumed.totalRequests },
      t: Math.floor(Date.now() / 1000),
    };

    try {
      this.dhtSeq++;
      await dht.mutablePut(keyPair, Buffer.from(JSON.stringify(payload)), { seq: this.dhtSeq });
      this.requestsSincePublish = 0;
      this.dirty = false;
      this.save(); // persist updated seq
      logger.debug(`[P2P Stats] Published stats to DHT (seq=${this.dhtSeq})`);
    } catch (err: any) {
      logger.warn('[P2P Stats] Failed to publish to DHT:', err.message);
      this.dhtSeq--; // revert on failure so next attempt uses same seq
    }
  }

  async fetchPeerStats(dht: any, publicKey: Buffer, peerId: string): Promise<P2PDHTStats | null> {
    // Cooldown: don't re-fetch within 30 seconds
    const cached = this.peerStatsCache.get(peerId);
    if (cached && Date.now() - cached.fetchedAt < 30_000) {
      return cached.stats;
    }

    try {
      const result = await dht.mutableGet(publicKey, { latest: true });
      if (!result?.value) return cached?.stats ?? null;

      const parsed: P2PDHTStats = JSON.parse(result.value.toString());
      if (parsed.v !== 1) return cached?.stats ?? null;

      this.peerStatsCache.set(peerId, { stats: parsed, fetchedAt: Date.now() });
      return parsed;
    } catch (err: any) {
      logger.debug(`[P2P Stats] Failed to fetch peer stats from DHT for ${peerId.slice(0, 8)}:`, err.message);
      return cached?.stats ?? null;
    }
  }

  /** Update peer stats from a catalog message (real-time, no DHT fetch needed) */
  updatePeerFromCatalog(peerId: string, peerName: string, stats: { si: number; so: number; ci: number; co: number }): void {
    const existing = this.peerStatsCache.get(peerId);
    const dhtStats: P2PDHTStats = {
      v: 1,
      n: peerName,
      s: { i: stats.si, o: stats.so, r: existing?.stats?.s?.r ?? 0 },
      c: { i: stats.ci, o: stats.co, r: existing?.stats?.c?.r ?? 0 },
      t: Math.floor(Date.now() / 1000),
    };
    this.peerStatsCache.set(peerId, { stats: dhtStats, fetchedAt: Date.now() });
  }

  // --- Leaderboard ---

  buildLeaderboard(
    networkKey: string,
    connectedPeerIds: Set<string>,
    selfPeerId: string,
    selfPeerName: string,
  ): P2PLeaderboardEntry[] {
    const entries: P2PLeaderboardEntry[] = [];

    // Add self
    const selfNet = this.networks.get(networkKey);
    entries.push({
      peerId: selfPeerId,
      peerName: selfPeerName,
      servedInputTokens: selfNet?.served.totalInputTokens ?? 0,
      servedOutputTokens: selfNet?.served.totalOutputTokens ?? 0,
      servedTotalTokens: (selfNet?.served.totalInputTokens ?? 0) + (selfNet?.served.totalOutputTokens ?? 0),
      servedRequests: selfNet?.served.totalRequests ?? 0,
      consumedInputTokens: selfNet?.consumed.totalInputTokens ?? 0,
      consumedOutputTokens: selfNet?.consumed.totalOutputTokens ?? 0,
      consumedTotalTokens: (selfNet?.consumed.totalInputTokens ?? 0) + (selfNet?.consumed.totalOutputTokens ?? 0),
      consumedRequests: selfNet?.consumed.totalRequests ?? 0,
      online: true,
      lastUpdated: selfNet?.lastUpdated ?? 0,
      isSelf: true,
    });

    // Add peers from cache
    for (const [peerId, { stats }] of this.peerStatsCache) {
      if (peerId === selfPeerId) continue;
      entries.push({
        peerId,
        peerName: stats.n,
        servedInputTokens: stats.s.i,
        servedOutputTokens: stats.s.o,
        servedTotalTokens: stats.s.i + stats.s.o,
        servedRequests: stats.s.r,
        consumedInputTokens: stats.c.i,
        consumedOutputTokens: stats.c.o,
        consumedTotalTokens: stats.c.i + stats.c.o,
        consumedRequests: stats.c.r,
        online: connectedPeerIds.has(peerId),
        lastUpdated: stats.t * 1000,
        isSelf: false,
      });
    }

    // Sort by served total tokens descending
    entries.sort((a, b) => b.servedTotalTokens - a.servedTotalTokens);
    return entries;
  }

  // --- DHT Publish Timer ---

  startPublishTimer(publishFn: () => Promise<void>): void {
    this.publishTimer = setInterval(async () => {
      if (this.dirty) {
        try { await publishFn(); } catch (err: any) {
          logger.warn('[P2P Stats] Periodic publish failed:', err.message);
        }
      }
    }, 60_000);
  }

  stopPublishTimer(): void {
    if (this.publishTimer) {
      clearInterval(this.publishTimer);
      this.publishTimer = null;
    }
  }

  /** Clear peer stats cache (call on network key change) */
  clearPeerCache(): void {
    this.peerStatsCache.clear();
  }

  /** Flush pending save and do a final DHT publish */
  async flushAndClose(dht: any, keyPair: any, networkKey: string, peerName: string): Promise<void> {
    this.stopPublishTimer();
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    if (this.dirty) {
      this.save();
      if (dht && keyPair) {
        try { await this.publishToDHT(dht, keyPair, networkKey, peerName); } catch {
          // Best-effort on shutdown
        }
      }
    }
  }
}
