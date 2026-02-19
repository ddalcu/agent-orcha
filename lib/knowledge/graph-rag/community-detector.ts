import type { AbstractGraph, Attributes } from 'graphology-types';
import type { MemoryGraphStore } from './memory-graph-store.ts';
import type { Community, GraphCommunitiesConfig } from './types.ts';
import { createLogger } from '../../logger.ts';

const logger = createLogger('CommunityDetector');

/**
 * Louvain community detection on the in-memory graph.
 * Groups nodes into communities based on graph structure (edge density).
 */
export class CommunityDetector {
  private config: GraphCommunitiesConfig;

  constructor(config: GraphCommunitiesConfig) {
    this.config = config;
  }

  /**
   * Detect communities in the graph store.
   * Only works with MemoryGraphStore (requires graphology instance).
   */
  async detect(store: MemoryGraphStore): Promise<Community[]> {
    const graph = await store.getGraphologyInstance();

    if (graph.order === 0) {
      logger.warn('Graph is empty, no communities to detect');
      return [];
    }

    // Dynamic imports to handle ESM/CJS interop
    const graphology = await import('graphology');
    const GraphClass = graphology.default ?? graphology;
    const louvainModule = await import('graphology-communities-louvain');
    const louvain = louvainModule.default ?? louvainModule;

    // graphology-communities-louvain requires an undirected graph for community detection.
    // Create a temporary undirected copy.
    const undirected: AbstractGraph = new (GraphClass as any)({ type: 'undirected' });

    graph.forEachNode((nodeId: string, attrs: Attributes) => {
      undirected.addNode(nodeId, attrs);
    });

    graph.forEachEdge((_edgeKey: string, attrs: Attributes, source: string, target: string) => {
      if (source === target) return; // skip self-loops
      if (!undirected.hasEdge(source, target)) {
        undirected.addEdge(source, target, { weight: (attrs as Record<string, unknown>).weight ?? 1 });
      } else {
        // Merge edge weights
        const existing = undirected.getEdgeAttributes(source, target) as { weight: number };
        undirected.setEdgeAttribute(
          source, target, 'weight',
          existing.weight + (((attrs as Record<string, unknown>).weight as number) ?? 1)
        );
      }
    });

    if (undirected.size === 0) {
      logger.warn('No edges in graph, each node becomes its own community');
      const communities: Community[] = [];
      let i = 0;
      graph.forEachNode((nodeId: string) => {
        communities.push({ id: `community-${i}`, nodeIds: [nodeId] });
        i++;
      });
      return communities.filter((c) => c.nodeIds.length >= this.config.minSize);
    }

    logger.info(`Running Louvain on ${undirected.order} nodes, ${undirected.size} edges (resolution: ${this.config.resolution})`);

    // Run Louvain algorithm
    const assignments = (louvain as any)(undirected, {
      resolution: this.config.resolution,
    }) as Record<string, number>;

    // Group nodes by community
    const communityMap = new Map<number, string[]>();
    for (const [nodeId, communityId] of Object.entries(assignments)) {
      const existing = communityMap.get(communityId) ?? [];
      existing.push(nodeId);
      communityMap.set(communityId, existing);
    }

    // Filter by minimum size and create Community objects
    const communities: Community[] = [];
    for (const [id, nodeIds] of communityMap.entries()) {
      if (nodeIds.length >= this.config.minSize) {
        communities.push({
          id: `community-${id}`,
          nodeIds,
        });
      }
    }

    logger.info(`Detected ${communities.length} communities (min size: ${this.config.minSize})`);
    return communities;
  }
}
