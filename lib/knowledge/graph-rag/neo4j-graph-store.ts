import type { GraphStore, GraphNode, GraphEdge, Community } from './types.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('Neo4jGraphStore');

interface Neo4jOptions {
  uri: string;
  username: string;
  password: string;
  database?: string;
}

/**
 * Neo4j-backed graph store implementation.
 * Requires neo4j-driver as a peer dependency.
 */
export class Neo4jGraphStore implements GraphStore {
  private driver: any;
  private database: string;
  private communities: Community[] = [];

  constructor(private options: Neo4jOptions) {
    this.database = options.database ?? 'neo4j';
  }

  private async getDriver(): Promise<any> {
    if (this.driver) return this.driver;
    try {
      const neo4j = await import('neo4j-driver');
      this.driver = neo4j.default.driver(
        this.options.uri,
        neo4j.default.auth.basic(this.options.username, this.options.password)
      );
      await this.driver.verifyConnectivity();
      logger.info(`Connected to Neo4j at ${this.options.uri}`);
      return this.driver;
    } catch (error) {
      throw new Error(`Failed to connect to Neo4j: ${error instanceof Error ? error.message : String(error)}. Install neo4j-driver: npm install neo4j-driver`);
    }
  }

  private async runQuery(query: string, params: Record<string, unknown> = {}): Promise<any[]> {
    const driver = await this.getDriver();
    const session = driver.session({ database: this.database });
    try {
      const result = await session.run(query, params);
      return result.records;
    } finally {
      await session.close();
    }
  }

  async addNodes(nodes: GraphNode[]): Promise<void> {
    for (const node of nodes) {
      await this.runQuery(
        `MERGE (n:Entity {id: $id})
         SET n.type = $type, n.name = $name, n.description = $description,
             n.properties = $properties, n.sourceChunkIds = $sourceChunkIds,
             n.embedding = $embedding`,
        {
          id: node.id,
          type: node.type,
          name: node.name,
          description: node.description,
          properties: JSON.stringify(node.properties),
          sourceChunkIds: node.sourceChunkIds,
          embedding: node.embedding ?? [],
        }
      );
    }
    logger.info(`Added ${nodes.length} nodes to Neo4j`);
  }

  async addEdges(edges: GraphEdge[]): Promise<void> {
    for (const edge of edges) {
      await this.runQuery(
        `MATCH (source:Entity {id: $sourceId}), (target:Entity {id: $targetId})
         MERGE (source)-[r:RELATES {id: $id}]->(target)
         SET r.type = $type, r.description = $description, r.weight = $weight,
             r.properties = $properties`,
        {
          id: edge.id,
          type: edge.type,
          sourceId: edge.sourceId,
          targetId: edge.targetId,
          description: edge.description,
          weight: edge.weight,
          properties: JSON.stringify(edge.properties),
        }
      );
    }
    logger.info(`Added ${edges.length} edges to Neo4j`);
  }

  async getNode(id: string): Promise<GraphNode | undefined> {
    const records = await this.runQuery(
      `MATCH (n:Entity {id: $id}) RETURN n`,
      { id }
    );
    if (records.length === 0) return undefined;
    return this.recordToNode(records[0].get('n'));
  }

  async getNeighbors(nodeId: string, depth: number): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    // Fetch nodes
    const nodeRecords = await this.runQuery(
      `MATCH (start:Entity {id: $nodeId})-[*1..${depth}]-(n:Entity)
       RETURN DISTINCT n`,
      { nodeId }
    );
    // Also include the start node
    const startRecords = await this.runQuery(
      `MATCH (n:Entity {id: $nodeId}) RETURN n`,
      { nodeId }
    );
    // Fetch edges with source/target IDs
    const edgeRecords = await this.runQuery(
      `MATCH (start:Entity {id: $nodeId})-[*0..${Math.max(0, depth - 1)}]-(s:Entity)-[r:RELATES]-(t:Entity)
       WHERE (start)-[*1..${depth}]-(s) OR s.id = $nodeId
       RETURN DISTINCT r, s.id AS sourceId, t.id AS targetId`,
      { nodeId }
    );

    const nodesMap = new Map<string, GraphNode>();
    for (const record of [...startRecords, ...nodeRecords]) {
      const node = this.recordToNode(record.get('n'));
      nodesMap.set(node.id, node);
    }

    const edgesMap = new Map<string, GraphEdge>();
    for (const record of edgeRecords) {
      const edge = this.recordToEdge(record.get('r'), record.get('sourceId'), record.get('targetId'));
      edgesMap.set(edge.id, edge);
    }

    return {
      nodes: Array.from(nodesMap.values()),
      edges: Array.from(edgesMap.values()),
    };
  }

  async findNodesByEmbedding(embedding: number[], k: number): Promise<GraphNode[]> {
    // Neo4j vector search requires a vector index to be set up.
    // For now, fall back to fetching all nodes and computing similarity in-memory.
    const allNodes = await this.getAllNodes();
    const scored = allNodes
      .filter((n) => n.embedding && n.embedding.length > 0)
      .map((n) => ({ node: n, score: cosineSimilarity(embedding, n.embedding!) }))
      .filter((s) => isFinite(s.score))
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, k).map((s) => s.node);
  }

  async getCommunities(): Promise<Community[]> {
    return this.communities;
  }

  async setCommunities(communities: Community[]): Promise<void> {
    this.communities = communities;
    // Persist community assignments to Neo4j nodes
    for (const community of communities) {
      for (const nodeId of community.nodeIds) {
        await this.runQuery(
          `MATCH (n:Entity {id: $nodeId})
           SET n.communityId = $communityId`,
          { nodeId, communityId: community.id }
        );
      }
    }
  }

  async getAllNodes(): Promise<GraphNode[]> {
    const records = await this.runQuery(`MATCH (n:Entity) RETURN n`);
    return records.map((r) => this.recordToNode(r.get('n')));
  }

  async getAllEdges(): Promise<GraphEdge[]> {
    const records = await this.runQuery(
      `MATCH (s:Entity)-[r:RELATES]->(t:Entity) RETURN r, s.id AS sourceId, t.id AS targetId`
    );
    return records.map((r) => this.recordToEdge(r.get('r'), r.get('sourceId'), r.get('targetId')));
  }

  async clear(): Promise<void> {
    await this.runQuery(`MATCH (n:Entity) DETACH DELETE n`);
    this.communities = [];
    logger.info('Cleared all Neo4j graph data');
  }

  async close(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
    }
  }

  private recordToNode(record: any): GraphNode {
    const props = record.properties;
    return {
      id: props.id,
      type: props.type,
      name: props.name,
      description: props.description,
      properties: props.properties ? JSON.parse(props.properties) : {},
      sourceChunkIds: props.sourceChunkIds ?? [],
      embedding: props.embedding ?? undefined,
    };
  }

  private recordToEdge(record: any, sourceId?: string, targetId?: string): GraphEdge {
    const props = record.properties;
    return {
      id: props.id,
      type: props.type,
      sourceId: sourceId ?? props.sourceId ?? '',
      targetId: targetId ?? props.targetId ?? '',
      description: props.description,
      weight: typeof props.weight === 'number' ? props.weight : 1,
      properties: props.properties ? JSON.parse(props.properties) : {},
    };
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
