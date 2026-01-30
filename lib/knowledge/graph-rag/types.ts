import { z } from 'zod';

// --- Graph Data Structures ---

export interface GraphNode {
  id: string;
  type: string;
  name: string;
  description: string;
  properties: Record<string, unknown>;
  sourceChunkIds: string[];
  embedding?: number[];
}

export interface GraphEdge {
  id: string;
  type: string;
  sourceId: string;
  targetId: string;
  description: string;
  weight: number;
  properties: Record<string, unknown>;
}

export interface Community {
  id: string;
  nodeIds: string[];
  summary?: string;
  title?: string;
}

// --- Graph Store Interface ---

export interface GraphStore {
  addNodes(nodes: GraphNode[]): Promise<void>;
  addEdges(edges: GraphEdge[]): Promise<void>;
  getNode(id: string): Promise<GraphNode | undefined>;
  getNeighbors(nodeId: string, depth: number): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }>;
  findNodesByEmbedding(embedding: number[], k: number): Promise<GraphNode[]>;
  getCommunities(): Promise<Community[]>;
  setCommunities(communities: Community[]): Promise<void>;
  getAllNodes(): Promise<GraphNode[]>;
  getAllEdges(): Promise<GraphEdge[]>;
  clear(): Promise<void>;
}

// --- Extraction Types ---

export interface ExtractedEntity {
  name: string;
  type: string;
  description: string;
  properties: Record<string, unknown>;
}

export interface ExtractedRelationship {
  sourceName: string;
  sourceType: string;
  targetName: string;
  targetType: string;
  type: string;
  description: string;
  weight: number;
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
}

// --- Cache Types ---

export interface CacheMetadata {
  sourceHash: string;
  extractedAt: string;
  configVersion: string;
}

export interface CachedGraphData {
  metadata: CacheMetadata;
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
  communities: Community[];
}

// --- Zod Schemas for YAML Config ---

export const EntityTypeSchema = z.object({
  name: z.string(),
  description: z.string().optional().default(''),
});

export const RelationshipTypeSchema = z.object({
  name: z.string(),
  description: z.string().optional().default(''),
});

export const GraphExtractionConfigSchema = z.object({
  llm: z.string().default('default'),
  entityTypes: z.array(EntityTypeSchema).optional(),
  relationshipTypes: z.array(RelationshipTypeSchema).optional(),
});

export const GraphCommunitiesConfigSchema = z.object({
  algorithm: z.literal('louvain').default('louvain'),
  resolution: z.number().default(1.0),
  minSize: z.number().default(2),
  summaryLlm: z.string().default('default'),
});

export const GraphStoreConfigSchema = z.object({
  type: z.enum(['memory', 'neo4j']).default('memory'),
  options: z.record(z.unknown()).optional().default({}),
});

export const GraphCacheConfigSchema = z.object({
  enabled: z.boolean().default(true),
  directory: z.string().default('.graph-cache'),
});

export const LocalSearchConfigSchema = z.object({
  maxDepth: z.number().default(2),
});

export const GlobalSearchConfigSchema = z.object({
  topCommunities: z.number().default(5),
  llm: z.string().default('default'),
});

export const GraphConfigSchema = z.object({
  extraction: GraphExtractionConfigSchema.optional().default({}),
  communities: GraphCommunitiesConfigSchema.optional().default({}),
  store: GraphStoreConfigSchema.optional().default({}),
  cache: GraphCacheConfigSchema.optional().default({}),
});

export const GraphSearchConfigSchema = z.object({
  defaultK: z.number().default(10),
  localSearch: LocalSearchConfigSchema.optional().default({}),
  globalSearch: GlobalSearchConfigSchema.optional().default({}),
});

// --- Inferred Types ---

export type EntityTypeConfig = z.infer<typeof EntityTypeSchema>;
export type RelationshipTypeConfig = z.infer<typeof RelationshipTypeSchema>;
export type GraphExtractionConfig = z.infer<typeof GraphExtractionConfigSchema>;
export type GraphCommunitiesConfig = z.infer<typeof GraphCommunitiesConfigSchema>;
export type GraphStoreConfig = z.infer<typeof GraphStoreConfigSchema>;
export type GraphCacheConfig = z.infer<typeof GraphCacheConfigSchema>;
export type GraphConfig = z.infer<typeof GraphConfigSchema>;
export type LocalSearchConfig = z.infer<typeof LocalSearchConfigSchema>;
export type GlobalSearchConfig = z.infer<typeof GlobalSearchConfigSchema>;
export type GraphSearchConfig = z.infer<typeof GraphSearchConfigSchema>;
