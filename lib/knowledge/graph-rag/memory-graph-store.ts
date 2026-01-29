import type { AbstractGraph, Attributes } from 'graphology-types';
import type { GraphStore, GraphNode, GraphEdge, Community } from './types.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('MemoryGraphStore');

// Dynamic import to handle ESM/CJS interop
async function createGraph(options: Record<string, unknown>): Promise<AbstractGraph> {
  const graphology = await import('graphology');
  const Graph = graphology.default ?? graphology;
  return new (Graph as any)(options);
}

/**
 * In-memory graph store implementation using graphology.
 * Stores nodes with their embeddings for similarity search
 * and supports neighborhood traversal.
 */
export class MemoryGraphStore implements GraphStore {
  private graph!: AbstractGraph;
  private communities: Community[] = [];
  private initialized = false;

  private async ensureGraph(): Promise<AbstractGraph> {
    if (!this.initialized) {
      this.graph = await createGraph({ multi: true, type: 'directed' });
      this.initialized = true;
    }
    return this.graph;
  }

  async addNodes(nodes: GraphNode[]): Promise<void> {
    const graph = await this.ensureGraph();
    for (const node of nodes) {
      if (graph.hasNode(node.id)) {
        graph.mergeNodeAttributes(node.id, node as unknown as Attributes);
      } else {
        graph.addNode(node.id, node as unknown as Attributes);
      }
    }
    logger.info(`Added ${nodes.length} nodes (total: ${graph.order})`);
  }

  async addEdges(edges: GraphEdge[]): Promise<void> {
    const graph = await this.ensureGraph();
    for (const edge of edges) {
      if (!graph.hasNode(edge.sourceId) || !graph.hasNode(edge.targetId)) {
        logger.warn(`Skipping edge ${edge.id}: missing node (source=${edge.sourceId}, target=${edge.targetId})`);
        continue;
      }
      try {
        graph.addEdgeWithKey(edge.id, edge.sourceId, edge.targetId, edge as unknown as Attributes);
      } catch {
        // Edge key may already exist, merge attributes
        graph.mergeEdgeAttributes(edge.id, edge as unknown as Attributes);
      }
    }
    logger.info(`Added ${edges.length} edges (total: ${graph.size})`);
  }

  async getNode(id: string): Promise<GraphNode | undefined> {
    const graph = await this.ensureGraph();
    if (!graph.hasNode(id)) return undefined;
    return graph.getNodeAttributes(id) as unknown as GraphNode;
  }

  async getNeighbors(nodeId: string, depth: number): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    const graph = await this.ensureGraph();
    if (!graph.hasNode(nodeId)) {
      return { nodes: [], edges: [] };
    }

    const visitedNodes = new Set<string>();
    const collectedEdges = new Map<string, GraphEdge>();
    const queue: Array<{ id: string; currentDepth: number }> = [{ id: nodeId, currentDepth: 0 }];

    while (queue.length > 0) {
      const item = queue.shift()!;
      if (visitedNodes.has(item.id) || item.currentDepth > depth) continue;
      visitedNodes.add(item.id);

      if (item.currentDepth < depth) {
        // Traverse outbound edges
        graph.forEachOutEdge(item.id, (edgeKey: string, attrs: Attributes, _source: string, target: string) => {
          collectedEdges.set(edgeKey, attrs as unknown as GraphEdge);
          if (!visitedNodes.has(target)) {
            queue.push({ id: target, currentDepth: item.currentDepth + 1 });
          }
        });

        // Traverse inbound edges
        graph.forEachInEdge(item.id, (edgeKey: string, attrs: Attributes, source: string, _target: string) => {
          collectedEdges.set(edgeKey, attrs as unknown as GraphEdge);
          if (!visitedNodes.has(source)) {
            queue.push({ id: source, currentDepth: item.currentDepth + 1 });
          }
        });
      }
    }

    const nodes: GraphNode[] = [];
    for (const nid of visitedNodes) {
      nodes.push(graph.getNodeAttributes(nid) as unknown as GraphNode);
    }

    return { nodes, edges: Array.from(collectedEdges.values()) };
  }

  async findNodesByEmbedding(embedding: number[], k: number): Promise<GraphNode[]> {
    const graph = await this.ensureGraph();
    const scored: Array<{ node: GraphNode; score: number }> = [];

    graph.forEachNode((_nodeId: string, attrs: Attributes) => {
      const node = attrs as unknown as GraphNode;
      if (!node.embedding || node.embedding.length === 0) return;
      const score = cosineSimilarity(embedding, node.embedding);
      if (isFinite(score)) {
        scored.push({ node, score });
      }
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k).map((s) => s.node);
  }

  async getCommunities(): Promise<Community[]> {
    return this.communities;
  }

  async setCommunities(communities: Community[]): Promise<void> {
    this.communities = communities;
  }

  async getAllNodes(): Promise<GraphNode[]> {
    const graph = await this.ensureGraph();
    const nodes: GraphNode[] = [];
    graph.forEachNode((_key: string, attrs: Attributes) => {
      nodes.push(attrs as unknown as GraphNode);
    });
    return nodes;
  }

  async getAllEdges(): Promise<GraphEdge[]> {
    const graph = await this.ensureGraph();
    const edges: GraphEdge[] = [];
    graph.forEachEdge((_key: string, attrs: Attributes) => {
      edges.push(attrs as unknown as GraphEdge);
    });
    return edges;
  }

  async clear(): Promise<void> {
    if (this.initialized) {
      this.graph.clear();
    }
    this.communities = [];
  }

  /**
   * Returns the underlying graphology instance for community detection.
   */
  async getGraphologyInstance(): Promise<AbstractGraph> {
    return this.ensureGraph();
  }
}

/**
 * Cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}
