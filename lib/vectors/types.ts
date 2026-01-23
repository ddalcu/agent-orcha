import { z } from 'zod';

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

// S3 source configuration
export const S3SourceConfigSchema = z.object({
  type: z.literal('s3'),
  endpoint: z.string().optional().describe('Custom S3 endpoint (for MinIO, Wasabi, etc.)'),
  bucket: z.string().describe('S3 bucket name'),
  prefix: z.string().optional().describe('Folder/prefix filter'),
  region: z.string().default('us-east-1').describe('AWS region'),
  accessKeyId: z.string().optional().describe('AWS access key ID (or use AWS_ACCESS_KEY_ID env var)'),
  secretAccessKey: z.string().optional().describe('AWS secret access key (or use AWS_SECRET_ACCESS_KEY env var)'),
  pattern: z.string().optional().describe('Glob pattern for file filtering (e.g., "*.pdf")'),
  forcePathStyle: z.boolean().default(false).describe('Use path-style URLs (required for MinIO and some S3-compatible services)'),
});

// Discriminated union of all source types
export const SourceConfigSchema = z.discriminatedUnion('type', [
  DirectorySourceConfigSchema,
  FileSourceConfigSchema,
  DatabaseSourceConfigSchema,
  WebSourceConfigSchema,
  S3SourceConfigSchema,
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

export type DirectorySourceConfig = z.infer<typeof DirectorySourceConfigSchema>;
export type FileSourceConfig = z.infer<typeof FileSourceConfigSchema>;
export type DatabaseSourceConfig = z.infer<typeof DatabaseSourceConfigSchema>;
export type WebSourceConfig = z.infer<typeof WebSourceConfigSchema>;
export type S3SourceConfig = z.infer<typeof S3SourceConfigSchema>;
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
