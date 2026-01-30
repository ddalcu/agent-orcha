import type { Embeddings } from '@langchain/core/embeddings';
import type { GraphStore, GraphNode, GraphEdge, LocalSearchConfig } from './types.js';
import type { SearchResult } from '../types.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('GraphLocalSearch');

/**
 * Entity-neighborhood search.
 * 1. Embed the query
 * 2. Find top-K similar entity nodes by embedding
 * 3. Expand each node's neighborhood by maxDepth hops
 * 4. Return structured context as SearchResult[]
 */
export class LocalSearch {
  private store: GraphStore;
  private embeddings: Embeddings;
  private config: LocalSearchConfig;

  constructor(store: GraphStore, embeddings: Embeddings, config: LocalSearchConfig) {
    this.store = store;
    this.embeddings = embeddings;
    this.config = config;
  }

  async search(query: string, k: number): Promise<SearchResult[]> {
    logger.info(`Local search: "${query.substring(0, 50)}..." (k=${k}, depth=${this.config.maxDepth})`);

    // 1. Embed the query
    const queryEmbedding = await this.embeddings.embedQuery(query);

    // 2. Find top-K similar entity nodes
    const topNodes = await this.store.findNodesByEmbedding(queryEmbedding, k);
    if (topNodes.length === 0) {
      logger.warn('No matching entities found');
      return [];
    }

    logger.info(`Found ${topNodes.length} matching entities`);

    // 3. Expand each node's neighborhood
    const results: SearchResult[] = [];
    const processedNodes = new Set<string>();

    for (const node of topNodes) {
      if (processedNodes.has(node.id)) continue;

      const neighborhood = await this.store.getNeighbors(node.id, this.config.maxDepth);
      for (const n of neighborhood.nodes) {
        processedNodes.add(n.id);
      }

      const content = this.formatNeighborhood(node, neighborhood.nodes, neighborhood.edges);
      const score = this.computeRelevanceScore(queryEmbedding, node);

      results.push({
        content,
        metadata: {
          type: 'graph-local',
          entityId: node.id,
          entityName: node.name,
          entityType: node.type,
          neighborCount: neighborhood.nodes.length,
          edgeCount: neighborhood.edges.length,
        },
        score,
      });
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, k);
  }

  private formatNeighborhood(centerNode: GraphNode, nodes: GraphNode[], edges: GraphEdge[]): string {
    const lines: string[] = [];

    lines.push(`Entity: ${centerNode.name} (${centerNode.type})`);
    lines.push(`Description: ${centerNode.description}`);

    if (edges.length > 0) {
      lines.push('');
      lines.push('Relationships:');

      // Build a name lookup for readable edge formatting
      const nameMap = new Map<string, string>();
      for (const n of nodes) {
        nameMap.set(n.id, `${n.name} (${n.type})`);
      }

      for (const edge of edges) {
        const sourceName = nameMap.get(edge.sourceId) ?? edge.sourceId;
        const targetName = nameMap.get(edge.targetId) ?? edge.targetId;
        lines.push(`  ${sourceName} -[${edge.type}]-> ${targetName}: ${edge.description}`);
      }
    }

    // List connected entities
    const otherNodes = nodes.filter((n) => n.id !== centerNode.id);
    if (otherNodes.length > 0) {
      lines.push('');
      lines.push('Connected Entities:');
      for (const n of otherNodes) {
        lines.push(`  - ${n.name} (${n.type}): ${n.description}`);
      }
    }

    return lines.join('\n');
  }

  private computeRelevanceScore(queryEmbedding: number[], node: GraphNode): number {
    if (!node.embedding || node.embedding.length === 0) return 0.5;
    return cosineSimilarity(queryEmbedding, node.embedding);
  }
}

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
