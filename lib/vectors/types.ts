import { z } from 'zod';

export const SourceConfigSchema = z.object({
  type: z.enum(['directory', 'file', 'url', 'database']),
  path: z.string().describe('Path to source (relative to project root)'),
  pattern: z.string().optional(),
  recursive: z.boolean().default(true),
});

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
  type: z.enum(['memory', 'chroma', 'pinecone', 'qdrant']).default('memory'),
  options: z.record(z.unknown()).optional(),
});

export const SearchConfigSchema = z.object({
  defaultK: z.number().default(4),
  scoreThreshold: z.number().optional(),
});

export const VectorConfigSchema = z.object({
  name: z.string().describe('Unique vector store identifier'),
  description: z.string().describe('Human-readable description'),
  source: SourceConfigSchema,
  loader: LoaderConfigSchema,
  splitter: SplitterConfigSchema,
  embedding: EmbeddingRefSchema,
  store: StoreConfigSchema,
  search: SearchConfigSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type SourceConfig = z.infer<typeof SourceConfigSchema>;
export type LoaderConfig = z.infer<typeof LoaderConfigSchema>;
export type SplitterConfig = z.infer<typeof SplitterConfigSchema>;
export type StoreConfig = z.infer<typeof StoreConfigSchema>;
export type SearchConfig = z.infer<typeof SearchConfigSchema>;
export type VectorConfig = z.infer<typeof VectorConfigSchema>;

export interface SearchResult {
  content: string;
  metadata: Record<string, unknown>;
  score: number;
}

export interface DocumentInput {
  content: string;
  metadata?: Record<string, unknown>;
}

export interface VectorStoreInstance {
  config: VectorConfig;
  search: (query: string, k?: number) => Promise<SearchResult[]>;
  addDocuments: (documents: DocumentInput[]) => Promise<void>;
  refresh: () => Promise<void>;
}
