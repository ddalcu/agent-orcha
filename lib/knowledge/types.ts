import { z } from 'zod';
import type { KnowledgeStoreMetadata, IndexingProgressCallback } from './knowledge-store-metadata.ts';

// --- Source Configs ---

export const DirectorySourceConfigSchema = z.object({
  type: z.literal('directory'),
  path: z.string().describe('Path to directory (relative to project root)'),
  pattern: z.string().optional().describe('Glob pattern for file matching'),
  recursive: z.boolean().default(true),
});

export const FileSourceConfigSchema = z.object({
  type: z.literal('file'),
  path: z.string().describe('Path to file (relative to project root)'),
});

export const DatabaseSourceConfigSchema = z.object({
  type: z.literal('database'),
  connectionString: z.string().describe('Database connection string (postgresql:// or mysql://)'),
  query: z.string().describe('SQL query to fetch documents'),
  contentColumn: z.string().default('content').describe('Column containing document content'),
  metadataColumns: z.array(z.string()).optional().describe('Columns to include as metadata'),
  batchSize: z.number().default(100).describe('Number of rows to fetch per batch'),
});

export const WebSourceConfigSchema = z.object({
  type: z.literal('web'),
  url: z.string().url().describe('URL to scrape'),
  selector: z.string().optional().describe('CSS selector for targeted content extraction'),
  headers: z.record(z.string()).optional().describe('Custom headers for the request'),
});

export const SourceConfigSchema = z.discriminatedUnion('type', [
  DirectorySourceConfigSchema,
  FileSourceConfigSchema,
  DatabaseSourceConfigSchema,
  WebSourceConfigSchema,
]);

export const LoaderConfigSchema = z.object({
  type: z.enum(['text', 'pdf', 'csv', 'json', 'markdown']).default('text'),
  options: z.record(z.unknown()).optional(),
});

export const SplitterConfigSchema = z.object({
  type: z.enum(['character', 'recursive', 'token', 'markdown']).default('character'),
  chunkSize: z.number().default(1000),
  chunkOverlap: z.number().default(200),
  separator: z.string().optional(),
});

export const EmbeddingRefSchema = z.string().default('default');

export const SearchConfigSchema = z.object({
  defaultK: z.number().default(4),
  scoreThreshold: z.number().optional(),
});

// --- Extraction Types (moved from graph-rag/types.ts) ---

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

export interface EntityMapping {
  type: string;
  idColumn: string;
  nameColumn?: string;
  properties: (string | Record<string, string>)[];
}

export interface RelationshipMapping {
  type: string;
  source: string;
  target: string;
  sourceIdColumn: string;
  targetIdColumn: string;
}

export interface DirectMappingConfig {
  entities: EntityMapping[];
  relationships?: RelationshipMapping[];
}

// --- Graph Config Schemas (simplified — no communities, no cache, no store) ---

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

export const GraphConfigSchema = z.object({
  extractionMode: z.enum(['llm', 'direct']).optional().default('llm'),
  extraction: GraphExtractionConfigSchema.optional().default({}),
  directMapping: z.any().optional(), // DirectMappingConfig
});

// --- Unified Knowledge Config ---

export const KnowledgeConfigSchema = z.preprocess(
  (data: unknown) => {
    if (typeof data !== 'object' || data === null) return data;
    const d = data as Record<string, unknown>;

    // Migration: strip old fields
    const cleaned = { ...d };
    delete cleaned.kind;
    delete cleaned.store;

    // Migration: clean old graph sub-fields
    if (cleaned.graph && typeof cleaned.graph === 'object') {
      const g = { ...(cleaned.graph as Record<string, unknown>) };
      delete g.communities;
      delete g.cache;
      delete g.store;
      cleaned.graph = g;
    }

    // Migration: strip old search sub-fields
    if (cleaned.search && typeof cleaned.search === 'object') {
      const s = { ...(cleaned.search as Record<string, unknown>) };
      delete s.globalSearch;
      delete s.localSearch;
      cleaned.search = s;
    }

    return cleaned;
  },
  z.object({
    name: z.string().describe('Unique knowledge store identifier'),
    description: z.string().describe('Human-readable description'),
    source: SourceConfigSchema,
    loader: LoaderConfigSchema,
    splitter: SplitterConfigSchema,
    embedding: EmbeddingRefSchema,
    graph: GraphConfigSchema.optional(),
    search: SearchConfigSchema.optional(),
    metadata: z.record(z.unknown()).optional(),
  })
);

// --- Type Exports ---

export type DirectorySourceConfig = z.infer<typeof DirectorySourceConfigSchema>;
export type FileSourceConfig = z.infer<typeof FileSourceConfigSchema>;
export type DatabaseSourceConfig = z.infer<typeof DatabaseSourceConfigSchema>;
export type WebSourceConfig = z.infer<typeof WebSourceConfigSchema>;
export type SourceConfig = z.infer<typeof SourceConfigSchema>;
export type LoaderConfig = z.infer<typeof LoaderConfigSchema>;
export type SplitterConfig = z.infer<typeof SplitterConfigSchema>;
export type SearchConfig = z.infer<typeof SearchConfigSchema>;
export type EntityTypeConfig = z.infer<typeof EntityTypeSchema>;
export type RelationshipTypeConfig = z.infer<typeof RelationshipTypeSchema>;
export type GraphExtractionConfig = z.infer<typeof GraphExtractionConfigSchema>;
export type GraphConfig = z.infer<typeof GraphConfigSchema>;
export type KnowledgeConfig = z.infer<typeof KnowledgeConfigSchema>;

// Backward compatibility aliases
export type VectorKnowledgeConfig = KnowledgeConfig;
export type GraphRagKnowledgeConfig = KnowledgeConfig & { graph: GraphConfig };

export interface SearchResult {
  content: string;
  metadata: Record<string, unknown>;
  score: number;
}

export interface DocumentInput {
  content: string;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeStoreInstance {
  config: KnowledgeConfig;
  search: (query: string, k?: number) => Promise<SearchResult[]>;
  addDocuments: (documents: DocumentInput[]) => Promise<void>;
  refresh: (onProgress?: IndexingProgressCallback) => Promise<void>;
  getMetadata: () => KnowledgeStoreMetadata;
}

export type { KnowledgeStoreMetadata, KnowledgeStoreStatus, IndexingProgressEvent, IndexingProgressCallback, IndexingPhase } from './knowledge-store-metadata.ts';
