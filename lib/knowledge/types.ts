import { z } from 'zod';
import { GraphConfigSchema, GraphSearchConfigSchema } from './graph-rag/types.js';
import type { KnowledgeStoreMetadata, IndexingProgressCallback } from './knowledge-store-metadata.js';

// Directory source configuration
export const DirectorySourceConfigSchema = z.object({
  type: z.literal('directory'),
  path: z.string().describe('Path to directory (relative to project root)'),
  pattern: z.string().optional().describe('Glob pattern for file matching'),
  recursive: z.boolean().default(true),
});

// File source configuration
export const FileSourceConfigSchema = z.object({
  type: z.literal('file'),
  path: z.string().describe('Path to file (relative to project root)'),
});

// Database source configuration
export const DatabaseSourceConfigSchema = z.object({
  type: z.literal('database'),
  connectionString: z.string().describe('Database connection string (postgresql:// or mysql://)'),
  query: z.string().describe('SQL query to fetch documents'),
  contentColumn: z.string().default('content').describe('Column containing document content'),
  metadataColumns: z.array(z.string()).optional().describe('Columns to include as metadata'),
  batchSize: z.number().default(100).describe('Number of rows to fetch per batch'),
});

// Web scraping source configuration
export const WebSourceConfigSchema = z.object({
  type: z.literal('web'),
  url: z.string().url().describe('URL to scrape'),
  selector: z.string().optional().describe('CSS selector for targeted content extraction'),
  headers: z.record(z.string()).optional().describe('Custom headers for the request'),
});

// Discriminated union of all source types
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

// Embedding is now just a reference to a config name in llm.json
export const EmbeddingRefSchema = z.string().default('default');

export const StoreConfigSchema = z.object({
  type: z.enum(['memory']).default('memory'),
  options: z.record(z.unknown()).optional(),
});

export const SearchConfigSchema = z.object({
  defaultK: z.number().default(4),
  scoreThreshold: z.number().optional(),
});

// --- Vector Knowledge Config (existing, now with explicit kind) ---

export const VectorKnowledgeConfigSchema = z.object({
  kind: z.literal('vector').default('vector'),
  name: z.string().describe('Unique knowledge store identifier'),
  description: z.string().describe('Human-readable description'),
  source: SourceConfigSchema,
  loader: LoaderConfigSchema,
  splitter: SplitterConfigSchema,
  embedding: EmbeddingRefSchema,
  store: StoreConfigSchema,
  search: SearchConfigSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
});

// --- GraphRAG Knowledge Config ---

export const GraphRagKnowledgeConfigSchema = z.object({
  kind: z.literal('graph-rag'),
  name: z.string().describe('Unique knowledge store identifier'),
  description: z.string().describe('Human-readable description'),
  source: SourceConfigSchema,
  loader: LoaderConfigSchema,
  splitter: SplitterConfigSchema,
  embedding: EmbeddingRefSchema,
  graph: GraphConfigSchema,
  search: GraphSearchConfigSchema.optional().default({}),
  metadata: z.record(z.unknown()).optional(),
});

// --- Unified Knowledge Config (discriminated by kind) ---

/**
 * Unified schema that handles both vector and graph-rag configs.
 * Existing configs without a `kind` field default to 'vector'.
 */
export const KnowledgeConfigSchema = z.preprocess(
  (data: unknown) => {
    if (typeof data === 'object' && data !== null && !('kind' in data)) {
      return { ...data, kind: 'vector' };
    }
    return data;
  },
  z.discriminatedUnion('kind', [
    VectorKnowledgeConfigSchema,
    GraphRagKnowledgeConfigSchema,
  ])
);

export type DirectorySourceConfig = z.infer<typeof DirectorySourceConfigSchema>;
export type FileSourceConfig = z.infer<typeof FileSourceConfigSchema>;
export type DatabaseSourceConfig = z.infer<typeof DatabaseSourceConfigSchema>;
export type WebSourceConfig = z.infer<typeof WebSourceConfigSchema>;
export type SourceConfig = z.infer<typeof SourceConfigSchema>;
export type LoaderConfig = z.infer<typeof LoaderConfigSchema>;
export type SplitterConfig = z.infer<typeof SplitterConfigSchema>;
export type StoreConfig = z.infer<typeof StoreConfigSchema>;
export type SearchConfig = z.infer<typeof SearchConfigSchema>;
export type VectorKnowledgeConfig = z.infer<typeof VectorKnowledgeConfigSchema>;
export type GraphRagKnowledgeConfig = z.infer<typeof GraphRagKnowledgeConfigSchema>;
export type KnowledgeConfig = z.infer<typeof KnowledgeConfigSchema>;

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

export type { KnowledgeStoreMetadata, KnowledgeStoreStatus, IndexingProgressEvent, IndexingProgressCallback, IndexingPhase } from './knowledge-store-metadata.js';
