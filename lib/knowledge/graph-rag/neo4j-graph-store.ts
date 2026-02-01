import type { GraphStore, GraphNode, GraphEdge, Community } from './types.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('Neo4jGraphStore');

interface Neo4jOptions {
  uri: string;
  username: string;
  password: string;
  database?: string;
  knowledgeBaseName?: string;
}

/**
 * Neo4j-backed graph store implementation.
 * Requires neo4j-driver as a peer dependency.
 */
export class Neo4jGraphStore implements GraphStore {
  private driver: any;
  private database: string;
  private communities: Community[] = [];
  private kbNodeId: string | null = null;

  constructor(private options: Neo4jOptions) {
    this.database = options.database ?? 'neo4j';
    if (options.knowledgeBaseName) {
      this.kbNodeId = `knowledgebase::${options.knowledgeBaseName}`
        .toLowerCase()
        .replace(/[^a-z0-9:]+/g, '-')
        .replace(/^-|-$/g, '');
    }
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
      // Sanitize the type to create a valid Neo4j label
      const label = this.sanitizeLabel(node.type);

      // Use dynamic label - need to build the query string since labels can't be parameterized
      const query = `MERGE (n:Entity:\`${label}\` {id: $id})
         SET n.type = $type, n.name = $name, n.description = $description,
             n.properties = $properties, n.sourceChunkIds = $sourceChunkIds,
             n.embedding = $embedding`;

      await this.runQuery(query, {
        id: node.id,
        type: node.type,
        name: node.name,
        description: node.description,
        properties: JSON.stringify(node.properties),
        sourceChunkIds: node.sourceChunkIds,
        embedding: node.embedding ?? [],
      });
    }
    logger.info(`Added ${nodes.length} nodes to Neo4j`);
  }

  async addEdges(edges: GraphEdge[]): Promise<void> {
    for (const edge of edges) {
      // Sanitize the relationship type to create a valid Neo4j relationship type
      const relType = this.sanitizeLabel(edge.type);

      // Use dynamic relationship type - need to build the query string
      const query = `MATCH (source:Entity {id: $sourceId}), (target:Entity {id: $targetId})
         MERGE (source)-[r:\`${relType}\` {id: $id}]->(target)
         SET r.type = $type, r.description = $description, r.weight = $weight,
             r.properties = $properties`;

      await this.runQuery(query, {
        id: edge.id,
        type: edge.type,
        sourceId: edge.sourceId,
        targetId: edge.targetId,
        description: edge.description,
        weight: edge.weight,
        properties: JSON.stringify(edge.properties),
      });
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
    const kbFilter = this.kbNodeId
      ? `AND ALL(node IN nodes(p) WHERE node.type = 'KnowledgeBase' OR (node)-[:BELONGS_TO_KB]->(:Entity {id: $kbNodeId}))`
      : '';
    const edgeTypeFilter = `AND NONE(r IN relationships(p) WHERE type(r) = 'BELONGS_TO_KB')`;

    const params: Record<string, unknown> = { nodeId };
    if (this.kbNodeId) {
      params.kbNodeId = this.kbNodeId;
    }

    // Fetch neighbor nodes, staying within KB boundary and excluding BELONGS_TO_KB traversal
    const nodeRecords = await this.runQuery(
      `MATCH (start:Entity {id: $nodeId})
       MATCH p = (start)-[*1..${depth}]-(n:Entity)
       WHERE n.type <> 'KnowledgeBase' ${edgeTypeFilter} ${kbFilter}
       RETURN DISTINCT n`,
      params
    );

    // Also include the start node
    const startRecords = await this.runQuery(
      `MATCH (n:Entity {id: $nodeId}) RETURN n`,
      { nodeId }
    );

    const nodesMap = new Map<string, GraphNode>();
    for (const record of [...startRecords, ...nodeRecords]) {
      const node = this.recordToNode(record.get('n'));
      nodesMap.set(node.id, node);
    }

    // Fetch edges between the collected nodes (excluding BELONGS_TO_KB)
    const nodeIds = Array.from(nodesMap.keys());
    const edgesMap = new Map<string, GraphEdge>();

    if (nodeIds.length > 0) {
      const edgeRecords = await this.runQuery(
        `MATCH (s:Entity)-[r]->(t:Entity)
         WHERE s.id IN $nodeIds AND t.id IN $nodeIds
         AND type(r) <> 'BELONGS_TO_KB'
         RETURN DISTINCT r, s.id AS sourceId, t.id AS targetId`,
        { nodeIds }
      );

      for (const record of edgeRecords) {
        const edge = this.recordToEdge(record.get('r'), record.get('sourceId'), record.get('targetId'));
        edgesMap.set(edge.id, edge);
      }
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
    if (this.kbNodeId) {
      // Only return nodes belonging to this knowledge base
      const records = await this.runQuery(
        `MATCH (n:Entity)-[:BELONGS_TO_KB]->(kb:Entity {id: $kbNodeId}) RETURN n`,
        { kbNodeId: this.kbNodeId }
      );
      return records.map((r) => this.recordToNode(r.get('n')));
    }
    const records = await this.runQuery(`MATCH (n:Entity) RETURN n`);
    return records.map((r) => this.recordToNode(r.get('n')));
  }

  async getAllEdges(): Promise<GraphEdge[]> {
    if (this.kbNodeId) {
      // Only return edges between nodes belonging to this knowledge base
      const records = await this.runQuery(
        `MATCH (s:Entity)-[:BELONGS_TO_KB]->(kb:Entity {id: $kbNodeId})
         MATCH (t:Entity)-[:BELONGS_TO_KB]->(kb)
         MATCH (s)-[r]->(t)
         WHERE type(r) <> 'BELONGS_TO_KB'
         RETURN r, s.id AS sourceId, t.id AS targetId`,
        { kbNodeId: this.kbNodeId }
      );
      return records.map((r) => this.recordToEdge(r.get('r'), r.get('sourceId'), r.get('targetId')));
    }
    const records = await this.runQuery(
      `MATCH (s:Entity)-[r]->(t:Entity) RETURN r, s.id AS sourceId, t.id AS targetId`
    );
    return records.map((r) => this.recordToEdge(r.get('r'), r.get('sourceId'), r.get('targetId')));
  }

  /**
   * Sanitize a label or relationship type for use in Neo4j.
   * Neo4j labels and relationship types cannot contain spaces or special characters.
   */
  private sanitizeLabel(label: string): string {
    // Replace spaces and special characters with underscores
    // Keep only alphanumeric characters and underscores
    return label.replace(/[^a-zA-Z0-9_]/g, '_');
  }

  async clear(): Promise<void> {
    await this.runQuery(`MATCH (n:Entity) DETACH DELETE n`);
    this.communities = [];
    logger.info('Cleared all Neo4j graph data');
  }

  async clearByKnowledgeBase(kbName: string): Promise<void> {
    const kbNodeId = `knowledgebase::${kbName}`.toLowerCase().replace(/[^a-z0-9:]+/g, '-').replace(/^-|-$/g, '');

    // Delete all entity nodes that belong to this KB via BELONGS_TO_KB
    await this.runQuery(
      `MATCH (n:Entity)-[:BELONGS_TO_KB]->(kb:Entity {id: $kbNodeId})
       WHERE n.id <> $kbNodeId
       DETACH DELETE n`,
      { kbNodeId }
    );

    // Delete the KB master node itself
    await this.runQuery(
      `MATCH (kb:Entity {id: $kbNodeId}) DETACH DELETE kb`,
      { kbNodeId }
    );

    this.communities = [];
    logger.info(`Cleared Neo4j data for knowledge base "${kbName}" (kb node: ${kbNodeId})`);
  }

  /**
   * Run a raw readonly Cypher query and return plain JS objects.
   * Uses executeRead to enforce read-only at the driver level.
   */
  async query(cypher: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>[]> {
    const driver = await this.getDriver();
    const session = driver.session({ database: this.database });
    try {
      const result = await session.executeRead(async (tx: any) => {
        return tx.run(cypher, params);
      });
      return result.records.map((record: any) => {
        const obj: Record<string, unknown> = {};
        for (const key of record.keys) {
          obj[key] = neo4jValueToPlain(record.get(key));
        }
        return obj;
      });
    } finally {
      await session.close();
    }
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

/**
 * Convert Neo4j driver values (Integer, Node, Relationship, Path, etc.) to plain JS objects.
 */
function neo4jValueToPlain(value: any): unknown {
  if (value === null || value === undefined) return value;

  // Neo4j Integer (has low/high fields)
  if (typeof value === 'object' && 'low' in value && 'high' in value && typeof value.toNumber === 'function') {
    return value.toNumber();
  }

  // Neo4j Node
  if (typeof value === 'object' && 'labels' in value && 'properties' in value && 'identity' in value) {
    return {
      _id: neo4jValueToPlain(value.identity),
      _labels: value.labels,
      ...flattenProperties(value.properties),
    };
  }

  // Neo4j Relationship
  if (typeof value === 'object' && 'type' in value && 'properties' in value && 'start' in value && 'end' in value && 'identity' in value) {
    return {
      _id: neo4jValueToPlain(value.identity),
      _type: value.type,
      _startId: neo4jValueToPlain(value.start),
      _endId: neo4jValueToPlain(value.end),
      ...flattenProperties(value.properties),
    };
  }

  // Neo4j Path
  if (typeof value === 'object' && 'segments' in value && Array.isArray(value.segments)) {
    return {
      _segments: value.segments.map((seg: any) => ({
        start: neo4jValueToPlain(seg.start),
        relationship: neo4jValueToPlain(seg.relationship),
        end: neo4jValueToPlain(seg.end),
      })),
    };
  }

  // Arrays
  if (Array.isArray(value)) {
    return value.map(neo4jValueToPlain);
  }

  // Plain objects (but not special Neo4j types)
  if (typeof value === 'object' && value.constructor === Object) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = neo4jValueToPlain(v);
    }
    return result;
  }

  return value;
}

/**
 * Flatten Neo4j node/relationship properties, converting Neo4j types to plain JS.
 */
function flattenProperties(props: Record<string, any>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    result[key] = neo4jValueToPlain(value);
  }
  return result;
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
